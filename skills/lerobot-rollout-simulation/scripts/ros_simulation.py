"""Synchronous ROS client for LeRobot ovphysx rollouts."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import numpy as np


ROS_DLL_HANDLES = []


def enable_ros_runtime() -> None:
    runtime = os.environ.get("LEROBOT_ROS_RUNTIME", "")
    if not runtime:
        return
    dll_dir = str(Path(runtime) / "Library" / "bin")
    os.environ["PATH"] = f"{dll_dir};{os.environ.get('PATH', '')}"
    if hasattr(os, "add_dll_directory"):
        ROS_DLL_HANDLES.append(os.add_dll_directory(dll_dir))


def image_to_rgb(message) -> np.ndarray:
    channels = {"rgb8": 3, "rgba8": 4, "bgr8": 3, "bgra8": 4, "mono8": 1}
    if message.encoding not in channels:
        raise RuntimeError(f"Unsupported ROS image encoding: {message.encoding}")
    count = channels[message.encoding]
    rows = np.frombuffer(message.data, dtype=np.uint8).reshape(message.height, message.step)
    image = rows[:, : message.width * count].reshape(message.height, message.width, count)
    if message.encoding in {"bgr8", "bgra8"}:
        image = image[..., [2, 1, 0] + ([3] if count == 4 else [])]
    if count == 4:
        image = image[..., :3]
    elif count == 1:
        image = np.repeat(image, 3, axis=2)
    return np.ascontiguousarray(image)


class RosSimulation:
    def __init__(self, args):
        enable_ros_runtime()
        import rclpy
        from sensor_msgs.msg import JointState

        if not rclpy.ok():
            rclpy.init()
        self.rclpy = rclpy
        self.JointState = JointState
        self.node = rclpy.create_node("lerobot_rollout_simulation")
        self.args = args
        self.namespace = args.namespace.rstrip("/")
        self.joint_names: list[str] = []
        self.state: np.ndarray | None = None
        self.state_seq = 0
        self.images: dict[str, np.ndarray] = {}
        self.image_seq: dict[str, int] = {}
        self.sensor_names: list[str] = []
        self.node.create_subscription(JointState, f"{self.namespace}/joint_states", self._on_state, 10)
        self.command = self.node.create_publisher(JointState, f"{self.namespace}/command", 10)

    def _on_state(self, message) -> None:
        names = list(message.name)
        if self.state is not None and names != self.joint_names:
            raise RuntimeError("JointState order changed during rollout")
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
            images_ready = all(name in self.images for name in self.sensor_names)
            if self.state is not None and self.joint_names and images_ready:
                return
        missing = [name for name in self.sensor_names if name not in self.images]
        raise TimeoutError(f"ROS inputs not ready; joints={self.state is not None}, missing sensors={missing}")

    def observation(self) -> dict[str, np.ndarray]:
        if self.state is None:
            raise RuntimeError("Joint state is unavailable")
        result = {"observation.state": self.state.copy()}
        result.update({f"observation.images.{name}": self.images[name].copy() for name in self.sensor_names})
        return result

    def publish(self, action: np.ndarray) -> None:
        message = self.JointState()
        message.name = self.joint_names
        message.position = action.astype(float).tolist()
        self.command.publish(message)

    def step(self, action: np.ndarray) -> None:
        state_seq = self.state_seq
        image_seq = dict(self.image_seq)
        self.publish(action)
        deadline = time.monotonic() + self.args.frame_timeout
        while time.monotonic() < deadline:
            self.rclpy.spin_once(self.node, timeout_sec=0.01)
            state_ready = self.state_seq > state_seq
            images_ready = all(self.image_seq.get(s, 0) > image_seq.get(s, 0) for s in self.sensor_names)
            if state_ready and images_ready:
                return
        raise TimeoutError("Timed out waiting for fresh rollout state and sensor frames")

    def reset_to(self, target: np.ndarray) -> float:
        period = 1.0 / self.args.fps
        deadline = time.monotonic() + self.args.reset_time
        while time.monotonic() < deadline:
            started = time.monotonic()
            self.publish(target)
            self.rclpy.spin_once(self.node, timeout_sec=max(0.0, period - (time.monotonic() - started)))
        if self.state is None:
            raise RuntimeError("Joint state disappeared during reset")
        return float(np.max(np.abs(self.state - target)))

    def close(self) -> None:
        self.node.destroy_node()
        if self.rclpy.ok():
            self.rclpy.shutdown()
