#!/usr/bin/env python3
"""Record randomized-start-to-fixed-goal ROS demonstrations as a LeRobot dataset."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path

import numpy as np


TASK = "Move from a random initial joint pose to the fixed target pose"
ROS_DLL_HANDLES = []


def enable_ros_runtime() -> None:
    """Add the ROS runtime DLL directory after LeRobot native modules are loaded."""
    runtime = os.environ.get("LEROBOT_ROS_RUNTIME", "")
    if not runtime:
        return
    dll_dir = str(Path(runtime) / "Library" / "bin")
    os.environ["PATH"] = f"{dll_dir};{os.environ.get('PATH', '')}"
    if hasattr(os, "add_dll_directory"):
        ROS_DLL_HANDLES.append(os.add_dll_directory(dll_dir))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--repo-id", default="local/random-to-goal")
    parser.add_argument("--episodes", type=int, default=10)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--duration", type=float, default=3.0)
    parser.add_argument("--reset-time", type=float, default=2.0)
    parser.add_argument("--random-radius", type=float, default=0.25)
    parser.add_argument("--goal", default="", help="JSON joint map or ordered array; empty means all zeros")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--namespace", default="/lerobot")
    parser.add_argument("--image-topic-prefix", default="/lerobot/render")
    parser.add_argument("--sensors", default="auto", help="comma-separated names, auto, or none")
    parser.add_argument("--startup-timeout", type=float, default=20.0)
    parser.add_argument("--frame-timeout", type=float, default=5.0)
    parser.add_argument("--settle-tolerance", type=float, default=0.08)
    parser.add_argument("--use-videos", action="store_true")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.root.exists():
        raise SystemExit(f"Dataset root already exists; refusing to overwrite: {args.root}")
    for name in ("episodes", "fps"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name} must be positive")
    for name in ("duration", "reset_time", "startup_timeout", "frame_timeout"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} must be positive")
    if args.random_radius < 0:
        raise SystemExit("--random-radius must be non-negative")


def image_to_rgb(message) -> np.ndarray:
    channels = {"rgb8": 3, "rgba8": 4, "bgr8": 3, "bgra8": 4, "mono8": 1}
    if message.encoding not in channels:
        raise RuntimeError(f"Unsupported ROS image encoding: {message.encoding}")
    count = channels[message.encoding]
    row = np.frombuffer(message.data, dtype=np.uint8).reshape(message.height, message.step)
    image = row[:, : message.width * count].reshape(message.height, message.width, count)
    if message.encoding in {"bgr8", "bgra8"}:
        image = image[..., [2, 1, 0] + ([3] if count == 4 else [])]
    if count == 4:
        image = image[..., :3]
    elif count == 1:
        image = np.repeat(image, 3, axis=2)
    return np.ascontiguousarray(image)


class RosRecorder:
    def __init__(self, args: argparse.Namespace):
        import rclpy
        from rclpy.qos import DurabilityPolicy, QoSProfile
        from sensor_msgs.msg import JointState
        from std_msgs.msg import String

        if not rclpy.ok():
            rclpy.init()
        self.rclpy = rclpy
        self.JointState = JointState
        self.node = rclpy.create_node("lerobot_record_simulation")
        self.args = args
        self.namespace = args.namespace.rstrip("/")
        self.metadata_names: list[str] = []
        self.joint_names: list[str] = []
        self.state: np.ndarray | None = None
        self.state_seq = 0
        self.images: dict[str, np.ndarray] = {}
        self.image_seq: dict[str, int] = {}
        self.sensor_names: list[str] = []
        qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.node.create_subscription(String, f"{self.namespace}/metadata", self._on_metadata, qos)
        self.node.create_subscription(JointState, f"{self.namespace}/joint_states", self._on_state, 10)
        self.command = self.node.create_publisher(JointState, f"{self.namespace}/command", 10)

    def _on_metadata(self, message) -> None:
        names = list(json.loads(message.data).get("dof_names", []))
        if names:
            self.metadata_names = names

    def _on_state(self, message) -> None:
        names = list(message.name)
        if self.state is not None and names != self.joint_names:
            raise RuntimeError("JointState order changed during recording")
        self.joint_names = names
        self.state = np.asarray(message.position, dtype=np.float32)
        self.state_seq += 1

    def discover_sensors(self) -> list[str]:
        requested = self.args.sensors.strip()
        if requested.lower() == "none":
            return []
        if requested.lower() != "auto":
            return [item.strip() for item in requested.split(",") if item.strip()]
        prefix = re.escape(self.args.image_topic_prefix.rstrip("/"))
        pattern = re.compile(rf"^{prefix}/([^/]+)/image_raw$")
        deadline = time.monotonic() + self.args.startup_timeout
        while time.monotonic() < deadline:
            self.rclpy.spin_once(self.node, timeout_sec=0.1)
            found = sorted(
                match.group(1)
                for topic, _types in self.node.get_topic_names_and_types()
                if (match := pattern.match(topic))
            )
            if found:
                return found
        raise TimeoutError(f"No image topics discovered below {self.args.image_topic_prefix}")

    def subscribe_sensors(self, names: list[str]) -> None:
        from sensor_msgs.msg import Image

        self.sensor_names = names
        for sensor in names:
            if not re.fullmatch(r"[A-Za-z0-9_]+", sensor):
                raise ValueError(f"Invalid sensor name: {sensor}")
            topic = f"{self.args.image_topic_prefix.rstrip('/')}/{sensor}/image_raw"

            def callback(message, name=sensor):
                self.images[name] = image_to_rgb(message)
                self.image_seq[name] = self.image_seq.get(name, 0) + 1

            self.node.create_subscription(Image, topic, callback, 2)

    def wait_ready(self) -> None:
        deadline = time.monotonic() + self.args.startup_timeout
        while time.monotonic() < deadline:
            self.rclpy.spin_once(self.node, timeout_sec=0.1)
            if self.state is not None and self.joint_names and all(s in self.images for s in self.sensor_names):
                return
        missing = [s for s in self.sensor_names if s not in self.images]
        raise TimeoutError(f"ROS inputs not ready; joints={self.state is not None}, missing sensors={missing}")

    def publish(self, values: np.ndarray) -> None:
        message = self.JointState()
        message.name = self.joint_names
        message.position = values.astype(float).tolist()
        self.command.publish(message)

    def wait_fresh(self, state_seq: int, image_seq: dict[str, int]) -> None:
        deadline = time.monotonic() + self.args.frame_timeout
        while time.monotonic() < deadline:
            self.rclpy.spin_once(self.node, timeout_sec=0.02)
            state_ready = self.state_seq > state_seq
            images_ready = all(self.image_seq.get(s, 0) > image_seq.get(s, 0) for s in self.sensor_names)
            if state_ready and images_ready:
                return
        raise TimeoutError("Timed out waiting for a fresh joint state and sensor frame")

    def move_without_recording(self, target: np.ndarray) -> float:
        period = 1.0 / self.args.fps
        deadline = time.monotonic() + self.args.reset_time
        while time.monotonic() < deadline:
            start = time.monotonic()
            self.publish(target)
            self.rclpy.spin_once(self.node, timeout_sec=max(0.0, period - (time.monotonic() - start)))
        assert self.state is not None
        return float(np.max(np.abs(self.state - target)))

    def capture_after(self, action: np.ndarray) -> dict:
        before_state = self.state_seq
        before_images = dict(self.image_seq)
        self.publish(action)
        self.wait_fresh(before_state, before_images)
        assert self.state is not None
        frame = {
            "observation.state": self.state.copy(),
            "action": action.astype(np.float32),
            "task": TASK,
        }
        frame.update({f"observation.images.{s}": self.images[s].copy() for s in self.sensor_names})
        return frame

    def close(self) -> None:
        self.node.destroy_node()
        if self.rclpy.ok():
            self.rclpy.shutdown()


def resolve_goal(raw: str, names: list[str]) -> np.ndarray:
    if not raw:
        return np.zeros(len(names), dtype=np.float32)
    value = json.loads(raw)
    if isinstance(value, dict):
        unknown = sorted(set(value) - set(names))
        if unknown:
            raise ValueError(f"Goal contains unknown joints: {unknown}")
        return np.asarray([value.get(name, 0.0) for name in names], dtype=np.float32)
    result = np.asarray(value, dtype=np.float32)
    if result.shape != (len(names),):
        raise ValueError(f"Goal array must contain {len(names)} values")
    return result


def make_features(recorder: RosRecorder, use_videos: bool) -> dict:
    count = len(recorder.joint_names)
    features = {
        "observation.state": {"dtype": "float32", "shape": (count,), "names": recorder.joint_names},
        "action": {"dtype": "float32", "shape": (count,), "names": recorder.joint_names},
    }
    for sensor in recorder.sensor_names:
        features[f"observation.images.{sensor}"] = {
            "dtype": "video" if use_videos else "image",
            "shape": recorder.images[sensor].shape,
            "names": ["height", "width", "channels"],
        }
    return features


def main() -> int:
    args = parse_args()
    validate_args(args)
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    enable_ros_runtime()
    recorder = RosRecorder(args)
    dataset = None
    try:
        sensors = recorder.discover_sensors()
        recorder.subscribe_sensors(sensors)
        recorder.wait_ready()
        goal = resolve_goal(args.goal, recorder.joint_names)
        dataset = LeRobotDataset.create(
            repo_id=args.repo_id,
            root=args.root.resolve(),
            fps=args.fps,
            robot_type="ovphysx_ros",
            features=make_features(recorder, args.use_videos),
            use_videos=args.use_videos,
        )
        rng = np.random.default_rng(args.seed)
        steps = max(1, round(args.duration * args.fps))
        for episode in range(args.episodes):
            initial_target = goal + rng.uniform(-args.random_radius, args.random_radius, goal.shape)
            error = recorder.move_without_recording(initial_target.astype(np.float32))
            if error > args.settle_tolerance:
                recorder.node.get_logger().warning(
                    f"Episode {episode}: reset max error {error:.4f} exceeds {args.settle_tolerance:.4f}"
                )
            assert recorder.state is not None
            start = recorder.state.copy()
            for step in range(steps):
                t = (step + 1) / steps
                blend = t * t * (3.0 - 2.0 * t)
                action = start + (goal - start) * blend
                dataset.add_frame(recorder.capture_after(action))
            dataset.save_episode(parallel_encoding=False)
            print(json.dumps({"episode": episode, "reset_error": error, "frames": steps}))
        dataset.finalize()
        dataset = None
        reopened = LeRobotDataset(repo_id=args.repo_id, root=args.root.resolve())
        summary = {
            "root": str(args.root.resolve()),
            "repo_id": args.repo_id,
            "episodes": reopened.num_episodes,
            "frames": reopened.num_frames,
            "sensors": sensors,
            "joint_names": recorder.joint_names,
            "goal": goal.astype(float).tolist(),
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    finally:
        if dataset is not None:
            dataset.finalize()
        recorder.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
