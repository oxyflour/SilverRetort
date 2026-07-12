#!/usr/bin/env python3
"""Generate and evaluate a camera-conditioned LeRobot cube-pick policy."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
from ovphysx import PhysX, TensorType

from control import (
    APPROACH_LEFT,
    APPROACH_RIGHT,
    PREGRASP_RIGHT,
    RAISE_LEFT,
    RAISE_RIGHT,
    normalize_action,
    set_grip,
    set_open,
)


TASK = "Close the right gripper and lift the orange cube from the table"
ROS_DLL_HANDLES = []


def smoothstep(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


class PickupSim:
    def __init__(self, scene: Path, seed: int = 0):
        self.physx = PhysX(device="cpu")
        _, op = self.physx.add_usd(str(scene.resolve()))
        self.physx.wait_op(op)
        self.bindings = []
        self.dt = 1.0 / 60.0
        self.sim_time = self.dt
        self.physx.step_sync(self.dt, 0.0)
        self.position = self.bind("/World/**", TensorType.ARTICULATION_DOF_POSITION)
        self.target = self.bind("/World/**", TensorType.ARTICULATION_DOF_POSITION_TARGET)
        self.link_pose = self.bind("/World/**", TensorType.ARTICULATION_LINK_POSE)
        self.cube_pose = self.bind("/World/TargetCube", TensorType.RIGID_BODY_POSE)
        self.cube_velocity = self.bind("/World/TargetCube", TensorType.RIGID_BODY_VELOCITY)
        self.state = np.empty(self.position.shape, dtype=np.float32)
        self.command = np.empty(self.target.shape, dtype=np.float32)
        self.cube = np.empty(self.cube_pose.shape, dtype=np.float32)
        self.links = np.empty(self.link_pose.shape, dtype=np.float32)
        self.zero_cube_velocity = np.zeros(self.cube_velocity.shape, dtype=np.float32)
        self.position.read(self.state)
        self.target.read(self.command)
        self.names = list(self.position.dof_names)
        self.index = {name: i for i, name in enumerate(self.names)}
        self.rng = np.random.default_rng(seed)
        self.baseline_z = 0.695

    def bind(self, pattern: str, tensor_type: TensorType):
        binding = self.physx.create_tensor_binding(pattern, tensor_type=tensor_type, raise_if_empty=True)
        self.bindings.append(binding)
        return binding

    def step_physics(self, count: int = 1) -> None:
        for _ in range(count):
            self.physx.step_sync(self.dt, self.sim_time)
            self.sim_time += self.dt

    def read_state(self) -> np.ndarray:
        self.position.read(self.state)
        return self.state[0].copy()

    def read_cube(self) -> np.ndarray:
        self.cube_pose.read(self.cube)
        return self.cube[0].copy()

    def read_links(self) -> np.ndarray:
        self.link_pose.read(self.links)
        return self.links[0].copy()

    def write_action(self, action: np.ndarray, physics_steps: int = 3) -> np.ndarray:
        if action.shape != (len(self.names),) or not np.all(np.isfinite(action)):
            raise RuntimeError(f"Invalid action {action.shape}")
        applied = normalize_action(np.clip(action, -6.0, 6.0), self.index)
        self.command[0] = applied
        self.target.write(self.command)
        self.step_physics(physics_steps)
        return applied

    def interpolate(self, goal: np.ndarray, frames: int, physics_steps: int = 2) -> None:
        start = self.read_state()
        for frame in range(frames):
            blend = smoothstep((frame + 1) / frames)
            self.write_action(start + (goal - start) * blend, physics_steps)

    def pregrasp(self) -> np.ndarray:
        self.command[0] = self.read_state()
        self.target.write(self.command)
        self.step_physics(120)
        raised = self.read_state()
        for prefix, values in (("RightArm", RAISE_RIGHT), ("LeftArm", RAISE_LEFT)):
            for joint, value in enumerate(values):
                raised[self.index[f"{prefix}_{joint}"]] = value
        set_open(raised, self.index)
        self.interpolate(raised, 120)

        pregrasp = raised.copy()
        for joint, value in enumerate(PREGRASP_RIGHT):
            pregrasp[self.index[f"RightArm_{joint}"]] = value
        self.interpolate(pregrasp, 100)

        jitter = self.rng.uniform(-0.0015, 0.0015, size=2)
        self.cube[0] = np.array(
            [0.7825 + jitter[0], 0.3815 + jitter[1], 0.695, 0.0, 0.0, 0.0, 1.0],
            dtype=np.float32,
        )
        self.cube_pose.write(self.cube)
        self.cube_velocity.write(self.zero_cube_velocity)
        self.step_physics(30)
        self.baseline_z = float(self.read_cube()[2])

        approach = raised.copy()
        for prefix, values in (("RightArm", APPROACH_RIGHT), ("LeftArm", APPROACH_LEFT)):
            for joint, value in enumerate(values):
                approach[self.index[f"{prefix}_{joint}"]] = value
        self.interpolate(approach, 100)
        return self.read_state()

    def goals(self) -> tuple[np.ndarray, np.ndarray]:
        grip = self.read_state()
        set_grip(grip, self.index)
        lift = grip.copy()
        lift[self.index["RightArm_3"]] += 0.30
        lift[self.index["LeftArm_3"]] -= 0.30
        return grip, lift

    def expert_frames(self):
        grip, lift = self.goals()
        start = self.read_state()
        for goal, count in ((grip, 40), (lift, 40), (lift, 20)):
            phase_start = self.read_state() if goal is lift else start
            for frame in range(count):
                blend = 1.0 if count == 20 else smoothstep((frame + 1) / count)
                action = phase_start + (goal - phase_start) * blend
                applied = self.write_action(action)
                yield self.read_state(), self.read_cube(), applied

    def close(self) -> None:
        for binding in reversed(self.bindings):
            binding.destroy()
        self.physx.release()


def image_to_rgb(message) -> np.ndarray:
    channels = {"rgb8": 3, "rgba8": 4, "bgr8": 3, "bgra8": 4}
    if message.encoding not in channels:
        raise RuntimeError(f"Unsupported image encoding: {message.encoding}")
    count = channels[message.encoding]
    rows = np.frombuffer(message.data, dtype=np.uint8).reshape(message.height, message.step)
    image = rows[:, : message.width * count].reshape(message.height, message.width, count)
    if message.encoding in {"bgr8", "bgra8"}:
        image = image[..., [2, 1, 0] + ([3] if count == 4 else [])]
    return np.ascontiguousarray(image[..., :3])


class RosCameras:
    def __init__(self, sensor_names: list[str], timeout: float = 180.0):
        runtime = os.environ.get("LEROBOT_ROS_RUNTIME", "")
        ros_root = os.environ.get("LEROBOT_ROS_ROOT", "")
        dll_dirs = []
        if runtime:
            dll_dirs.append(str(Path(runtime) / "Library" / "bin"))
        if ros_root:
            dll_dirs.append(str(Path(ros_root) / "bin"))
        for dll_dir in dll_dirs:
            os.environ["PATH"] = f"{dll_dir};{os.environ.get('PATH', '')}"
            if hasattr(os, "add_dll_directory"):
                ROS_DLL_HANDLES.append(os.add_dll_directory(dll_dir))
        import rclpy
        from sensor_msgs.msg import Image
        from tf2_msgs.msg import TFMessage

        if not rclpy.ok():
            rclpy.init()
        self.rclpy = rclpy
        self.TFMessage = TFMessage
        self.node = rclpy.create_node("moz1_cube_pick_video_recorder")
        self.publisher = self.node.create_publisher(TFMessage, "/tf", 20)
        self.sensor_names = sensor_names
        self.timeout = timeout
        self.images: dict[str, np.ndarray] = {}
        self.sequences = {name: 0 for name in sensor_names}
        for name in sensor_names:
            topic = f"/lerobot/render/{name}/image_raw"

            def callback(message, sensor=name):
                self.images[sensor] = image_to_rgb(message)
                self.sequences[sensor] += 1

            self.node.create_subscription(Image, topic, callback, 2)

    def publish_poses(self, sim: PickupSim) -> None:
        from geometry_msgs.msg import TransformStamped

        stamp = self.node.get_clock().now().to_msg()
        message = self.TFMessage()
        for name, pose in zip(sim.link_pose.body_names, sim.read_links(), strict=True):
            item = TransformStamped()
            item.header.stamp = stamp
            item.header.frame_id = "world"
            item.child_frame_id = name
            item.transform.translation.x = float(pose[0])
            item.transform.translation.y = float(pose[1])
            item.transform.translation.z = float(pose[2])
            item.transform.rotation.x = float(pose[3])
            item.transform.rotation.y = float(pose[4])
            item.transform.rotation.z = float(pose[5])
            item.transform.rotation.w = float(pose[6])
            message.transforms.append(item)
        cube = sim.read_cube()
        item = TransformStamped()
        item.header.stamp = stamp
        item.header.frame_id = "world"
        item.child_frame_id = "TargetCube"
        item.transform.translation.x = float(cube[0])
        item.transform.translation.y = float(cube[1])
        item.transform.translation.z = float(cube[2])
        item.transform.rotation.x = float(cube[3])
        item.transform.rotation.y = float(cube[4])
        item.transform.rotation.z = float(cube[5])
        item.transform.rotation.w = float(cube[6])
        message.transforms.append(item)
        self.publisher.publish(message)

    def capture(self, sim: PickupSim) -> dict[str, np.ndarray]:
        before = dict(self.sequences)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            self.publish_poses(sim)
            self.rclpy.spin_once(self.node, timeout_sec=0.05)
            if all(self.sequences[name] > before[name] for name in self.sensor_names):
                return {name: self.images[name].copy() for name in self.sensor_names}
        missing = [name for name in self.sensor_names if self.sequences[name] <= before[name]]
        raise TimeoutError(f"Timed out waiting for rendered sensors: {missing}")

    def close(self) -> None:
        self.node.destroy_node()
        if self.rclpy.ok():
            self.rclpy.shutdown()


def generate(args: argparse.Namespace) -> int:
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    if args.root.exists():
        raise SystemExit(f"Refusing to overwrite existing dataset: {args.root}")
    sim = PickupSim(args.scene, args.seed)
    names = sim.names
    sensor_names = [name.strip() for name in args.sensors.split(",") if name.strip()]
    if not sensor_names:
        raise SystemExit("Visual generation requires at least one sensor in --sensors")
    cameras = RosCameras(sensor_names, args.frame_timeout)
    features = {
        "observation.state": {"dtype": "float32", "shape": (len(names),), "names": names},
        "action": {"dtype": "float32", "shape": (len(names),), "names": names},
    }
    for sensor in sensor_names:
        features[f"observation.images.{sensor}"] = {
            "dtype": "video" if args.use_videos else "image",
            "shape": (args.height, args.width, 3),
            "names": ["height", "width", "channels"],
        }
    dataset = LeRobotDataset.create(
        repo_id=args.repo_id, root=args.root.resolve(), fps=20,
        robot_type="ovphysx_cube_pickup", features=features, use_videos=args.use_videos,
    )
    metrics = []
    try:
        for episode in range(args.episodes):
            sim.rng = np.random.default_rng(args.seed + episode)
            sim.pregrasp()
            frames = 0
            for state, _cube, action in sim.expert_frames():
                frame = {
                    "observation.state": state,
                    "action": action,
                    "task": TASK,
                }
                images = cameras.capture(sim)
                for sensor, image in images.items():
                    expected = (args.height, args.width, 3)
                    if image.shape != expected:
                        raise RuntimeError(
                            f"Sensor {sensor} shape {image.shape} does not match {expected}"
                        )
                    frame[f"observation.images.{sensor}"] = image
                dataset.add_frame(frame)
                frames += 1
            lift = float(sim.read_cube()[2] - sim.baseline_z)
            success = lift >= 0.05
            metrics.append({"episode": episode, "frames": frames, "lift": lift, "success": success})
            dataset.save_episode(parallel_encoding=False)
            print(json.dumps(metrics[-1]))
        dataset.finalize()
        dataset = None
        reopened = LeRobotDataset(repo_id=args.repo_id, root=args.root.resolve())
        report = {
            "episodes": reopened.num_episodes,
            "frames": reopened.num_frames,
            "expert_success_rate": float(np.mean([m["success"] for m in metrics])),
            "episode_metrics": metrics,
        }
        (args.root / "generation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        return 0 if all(m["success"] for m in metrics) else 2
    finally:
        if dataset is not None:
            dataset.finalize()
        cameras.close()
        sim.close()


def load_policy(model: Path, dataset):
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies.factory import make_policy, make_pre_post_processors

    config = PreTrainedConfig.from_pretrained(str(model))
    config.pretrained_path = str(model)
    config.device = "cpu"
    policy = make_policy(config, ds_meta=dataset.meta)
    policy.eval()
    preprocessor, postprocessor = make_pre_post_processors(
        policy_cfg=config, pretrained_path=str(model),
        preprocessor_overrides={"device_processor": {"device": "cpu"}},
    )
    return policy, preprocessor, postprocessor


def evaluate(args: argparse.Namespace) -> int:
    import torch
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    from lerobot.utils.control_utils import predict_action

    if args.rollout_root is None or not args.rollout_repo_id:
        raise SystemExit("evaluate requires --rollout-root and --rollout-repo-id")
    if args.episodes != 1:
        raise SystemExit(
            "Independent MOZ01 evaluation requires --episodes 1. Run one process per seed "
            "with a unique rollout root and repo ID to avoid cross-episode simulator state."
        )
    if args.rollout_root.exists():
        raise SystemExit(f"Refusing to overwrite existing rollout dataset: {args.rollout_root}")
    training_dataset = LeRobotDataset(repo_id=args.repo_id, root=args.root.resolve())
    policy, preprocessor, postprocessor = load_policy(args.model, training_dataset)
    sensor_names = [name.strip() for name in args.sensors.split(",") if name.strip()]
    if not sensor_names:
        raise SystemExit("Visual evaluation requires at least one sensor in --sensors")
    expected_image_keys = {f"observation.images.{name}" for name in sensor_names}
    trained_image_keys = {
        name for name in training_dataset.meta.features if name.startswith("observation.images.")
    }
    if expected_image_keys != trained_image_keys:
        raise SystemExit(
            f"Evaluation sensors {sorted(expected_image_keys)} do not match training inputs "
            f"{sorted(trained_image_keys)}"
        )
    cameras = RosCameras(sensor_names, args.frame_timeout)
    features = {
        "observation.state": {
            "dtype": "float32", "shape": (len(training_dataset.meta.features["observation.state"]["names"]),),
            "names": training_dataset.meta.features["observation.state"]["names"],
        },
        "action": {
            "dtype": "float32", "shape": (len(training_dataset.meta.features["action"]["names"]),),
            "names": training_dataset.meta.features["action"]["names"],
        },
    }
    for sensor in sensor_names:
        features[f"observation.images.{sensor}"] = {
            "dtype": "video" if args.use_videos else "image",
            "shape": (args.height, args.width, 3),
            "names": ["height", "width", "channels"],
        }
    rollout_dataset = LeRobotDataset.create(
        repo_id=args.rollout_repo_id,
        root=args.rollout_root.resolve(),
        fps=20,
        robot_type="ovphysx_cube_pickup",
        features=features,
        use_videos=args.use_videos,
    )
    episode_metrics = []
    sim = PickupSim(args.scene, args.seed + 1000)
    try:
        for episode in range(args.episodes):
            sim.rng = np.random.default_rng(args.seed + 1000 + episode)
            sim.pregrasp()
            for item in (policy, preprocessor, postprocessor):
                reset = getattr(item, "reset", None)
                if reset:
                    reset()
            latencies = []
            heights = []
            for _ in range(120):
                state = sim.read_state()
                observation = {"observation.state": state}
                images = cameras.capture(sim)
                for sensor, image in images.items():
                    expected = (args.height, args.width, 3)
                    if image.shape != expected:
                        raise RuntimeError(
                            f"Sensor {sensor} shape {image.shape} does not match {expected}"
                        )
                    observation[f"observation.images.{sensor}"] = image
                started = time.perf_counter()
                output = predict_action(
                    observation=observation, policy=policy,
                    device=torch.device("cpu"), preprocessor=preprocessor,
                    postprocessor=postprocessor, use_amp=False, task=TASK,
                    robot_type="ovphysx_cube_pickup",
                )
                action = output.squeeze(0).detach().cpu().numpy().astype(np.float32)
                latencies.append((time.perf_counter() - started) * 1000.0)
                applied = sim.write_action(action)
                rollout_dataset.add_frame({**observation, "action": applied, "task": TASK})
                heights.append(float(sim.read_cube()[2] - sim.baseline_z))
            rollout_dataset.save_episode(parallel_encoding=False)
            hold_lift = min(heights[-20:])
            metric = {
                "episode": episode,
                "frames": len(heights),
                "final_lift": heights[-1],
                "minimum_hold_lift": hold_lift,
                "success": hold_lift >= 0.05,
                "mean_inference_ms": float(np.mean(latencies)),
                "finite": bool(
                    np.all(np.isfinite(sim.read_state()))
                    and np.all(np.isfinite(sim.read_cube()))
                ),
            }
            episode_metrics.append(metric)
            print(json.dumps(metric))
        rollout_dataset.finalize()
        rollout_dataset = None
        reopened = LeRobotDataset(
            repo_id=args.rollout_repo_id,
            root=args.rollout_root.resolve(),
        )
    finally:
        if rollout_dataset is not None:
            rollout_dataset.finalize()
        cameras.close()
        sim.close()
    report = {
        "model": str(args.model.resolve()),
        "episodes": len(episode_metrics),
        "dataset_root": str(args.rollout_root.resolve()),
        "repo_id": args.rollout_repo_id,
        "dataset_episodes": reopened.num_episodes,
        "dataset_frames": reopened.num_frames,
        "successes": sum(m["success"] for m in episode_metrics),
        "success_rate": float(np.mean([m["success"] for m in episode_metrics])),
        "mean_final_lift": float(np.mean([m["final_lift"] for m in episode_metrics])),
        "episode_metrics": episode_metrics,
    }
    output = args.output or args.rollout_root / "evaluation.json"
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("generate", "evaluate"))
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--episodes", type=int, default=20)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--rollout-root", type=Path)
    parser.add_argument("--rollout-repo-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sensors", default="")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--frame-timeout", type=float, default=180.0)
    parser.add_argument("--use-videos", action="store_true")
    args = parser.parse_args()
    if args.mode == "evaluate" and args.model is None:
        parser.error("evaluate requires --model")
    return generate(args) if args.mode == "generate" else evaluate(args)


if __name__ == "__main__":
    raise SystemExit(main())
