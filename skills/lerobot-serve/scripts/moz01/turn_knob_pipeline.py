#!/usr/bin/env python3
"""Record camera-conditioned expert episodes of MOZ01 turning the gas-stove knob.

The expert presses the closed right-hand fingertips onto the knob face and
drags them along a circular arc around the knob axis; friction turns the knob.
Motion parameters were validated headless on moz_gas_stove_scene.usda.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from ovphysx import PhysX, TensorType

from cartesian import FingertipIK
from control import RAISE_LEFT, RAISE_RIGHT, set_four_bar
from pickup_pipeline import RosCameras

TASK = "Press the gas stove knob with the right fingertips and turn it clockwise"
KNOB_PIVOT = np.array([0.600, 0.3207, 0.9527])
KNOB_AXIS_X = True  # knob rotates about world +X
STANDOFF_X = 0.68
PRESS_X = 0.617
ARC_RADIUS = 0.012
SWEEP_RAD = np.deg2rad(60.0)
PHI_START = np.pi / 2
SUCCESS_ANGLE = 0.8


def smoothstep(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


class KnobSim:
    """Root-locked MOZ01 + articulated stove; robot and stove bound separately."""

    def __init__(self, scene: Path):
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
        self.root_pose = self.bind("/World/**", TensorType.ARTICULATION_ROOT_POSE)
        self.root_velocity = self.bind("/World/**", TensorType.ARTICULATION_ROOT_VELOCITY)
        self.knob_position = self.bind_raw("/World/GasStove/**", TensorType.ARTICULATION_DOF_POSITION)
        self.stove_links = self.bind_raw("/World/GasStove/**", TensorType.ARTICULATION_LINK_POSE)
        self.state = np.empty(self.position.shape, dtype=np.float32)
        self.command = np.empty(self.target.shape, dtype=np.float32)
        self.links = np.empty(self.link_pose.shape, dtype=np.float32)
        self.initial_roots = np.empty(self.root_pose.shape, dtype=np.float32)
        self.zero_root_velocity = np.zeros(self.root_velocity.shape, dtype=np.float32)
        self.knob = np.empty(self.knob_position.shape, dtype=np.float32)
        self.stove = np.empty(self.stove_links.shape, dtype=np.float32)
        self.position.read(self.state)
        self.target.read(self.command)
        self.root_pose.read(self.initial_roots)
        self.names = list(self.position.dof_names)
        self.index = {name: i for i, name in enumerate(self.names)}
        self.fingertip_ik = FingertipIK(self)

    def bind_raw(self, pattern: str, tensor_type: TensorType):
        binding = self.physx.create_tensor_binding(pattern, tensor_type=tensor_type, raise_if_empty=True)
        self.bindings.append(binding)
        return binding

    def bind(self, pattern: str, tensor_type: TensorType):
        # FingertipIK binds "/World/**"; keep the stove articulation out of
        # every robot-shaped tensor by narrowing that pattern to the robot.
        if pattern == "/World/**":
            pattern = "/World/MOZ1/**"
        return self.bind_raw(pattern, tensor_type)

    def step_physics(self, count: int = 1) -> None:
        for _ in range(count):
            self.root_pose.write(self.initial_roots)
            self.root_velocity.write(self.zero_root_velocity)
            self.physx.step_sync(self.dt, self.sim_time)
            self.root_pose.write(self.initial_roots)
            self.root_velocity.write(self.zero_root_velocity)
            self.sim_time += self.dt

    def read_state(self) -> np.ndarray:
        self.position.read(self.state)
        return self.state[0].copy()

    def read_links(self) -> np.ndarray:
        self.link_pose.read(self.links)
        return self.links[0].copy()

    def read_knob(self) -> float:
        self.knob_position.read(self.knob)
        return float(self.knob.reshape(-1)[0])

    def read_stove_links(self) -> tuple[list[str], np.ndarray]:
        self.stove_links.read(self.stove)
        return list(self.stove_links.body_names), self.stove[0].copy()

    def write_action(self, action: np.ndarray, physics_steps: int = 3) -> np.ndarray:
        if action.shape != (len(self.names),) or not np.all(np.isfinite(action)):
            raise RuntimeError(f"Invalid action {action.shape}")
        applied = np.asarray(np.clip(action, -6.0, 6.0), dtype=np.float32).copy()
        for branch in ("narrow", "wide"):
            crank = float(applied[self.index[f"right_hand_{branch}1_joint"]])
            set_four_bar(applied, self.index, branch, crank)
        self.command[0] = applied
        self.target.write(self.command)
        self.step_physics(physics_steps)
        return applied

    def interpolate(self, goal: np.ndarray, frames: int, physics_steps: int = 2) -> None:
        start = self.read_state()
        for frame in range(frames):
            blend = smoothstep((frame + 1) / frames)
            self.write_action(start + (goal - start) * blend, physics_steps)

    def prepare(self) -> None:
        """Settle, then raise both arms with closed fingers (not recorded)."""
        self.command[0] = self.read_state()
        self.target.write(self.command)
        self.step_physics(90)
        raised = self.read_state()
        for prefix, values in (("RightArm", RAISE_RIGHT), ("LeftArm", RAISE_LEFT)):
            for joint, value in enumerate(values):
                raised[self.index[f"{prefix}_{joint}"]] = value
        for branch in ("narrow", "wide"):
            set_four_bar(raised, self.index, branch, 0.0)
        self.interpolate(raised, 120)

    def arc_point(self, phi: float, x: float) -> np.ndarray:
        return np.array([x, KNOB_PIVOT[1] + ARC_RADIUS * np.cos(phi), KNOB_PIVOT[2] + ARC_RADIUS * np.sin(phi)])

    def expert_frames(self):
        """Yield (state, knob_angle, applied_action) for one recorded episode."""
        # approach standoff, then press onto the knob face (headless-validated
        # caps and per-frame physics substeps; do not tighten them)
        for phase, target, frames, tol in (
            ("standoff", self.arc_point(PHI_START, STANDOFF_X), 120, 0.012),
            ("press", self.arc_point(PHI_START, PRESS_X), 80, 0.008),
        ):
            for frame in range(frames):
                action, center, error = self.fingertip_ik.action_toward(target)
                applied = self.write_action(action, physics_steps=4)
                if frame % 20 == 0:
                    print(f"phase={phase} frame={frame} tip={np.round(center,3).tolist()} "
                          f"knob={self.read_knob():+.3f}", flush=True)
                yield self.read_state(), self.read_knob(), applied
                if np.linalg.norm(error) < tol:
                    break
        # drag the fingertips along the arc; friction turns the knob
        sweep_frames = 90
        for frame in range(sweep_frames):
            phi = PHI_START - SWEEP_RAD * smoothstep((frame + 1) / sweep_frames)
            action, center, _error = self.fingertip_ik.action_toward(self.arc_point(phi, PRESS_X))
            applied = self.write_action(action)
            if frame % 20 == 0:
                print(f"phase=sweep frame={frame} tip={np.round(center,3).tolist()} "
                      f"knob={self.read_knob():+.3f}", flush=True)
            yield self.read_state(), self.read_knob(), applied
        # hold the final contact so the detent spring cannot back-drive it
        applied = self.write_action(self.read_state())
        for _ in range(14):
            applied = self.write_action(applied)
            yield self.read_state(), self.read_knob(), applied

    def close(self) -> None:
        for binding in reversed(self.bindings):
            binding.destroy()
        self.physx.release()


class KnobCameras(RosCameras):
    """RosCameras with stove bodies (instead of the pickup cube) in /tf."""

    def publish_poses(self, sim: KnobSim) -> None:
        from geometry_msgs.msg import TransformStamped

        stamp = self.node.get_clock().now().to_msg()
        message = self.TFMessage()

        def append(frame_id: str, pose) -> None:
            item = TransformStamped()
            item.header.stamp = stamp
            item.header.frame_id = "world"
            item.child_frame_id = frame_id
            item.transform.translation.x = float(pose[0])
            item.transform.translation.y = float(pose[1])
            item.transform.translation.z = float(pose[2])
            item.transform.rotation.x = float(pose[3])
            item.transform.rotation.y = float(pose[4])
            item.transform.rotation.z = float(pose[5])
            item.transform.rotation.w = float(pose[6])
            message.transforms.append(item)

        for name, pose in zip(sim.link_pose.body_names, sim.read_links(), strict=True):
            append(name, pose)
        stove_names, stove_poses = sim.read_stove_links()
        for name, pose in zip(stove_names, stove_poses, strict=True):
            append(name, pose)
        self.publisher.publish(message)


def generate(args: argparse.Namespace) -> int:
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    if args.root.exists():
        raise SystemExit(f"Refusing to overwrite existing dataset: {args.root}")
    sensor_names = [name.strip() for name in args.sensors.split(",") if name.strip()]
    if not sensor_names:
        raise SystemExit("Visual generation requires at least one sensor in --sensors")
    sim = KnobSim(args.scene)
    cameras = KnobCameras(sensor_names, args.frame_timeout)
    names = sim.names
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
        robot_type="ovphysx_knob_turn", features=features, use_videos=args.use_videos,
    )
    metrics = []
    try:
        for episode in range(args.episodes):
            sim.prepare()
            frames = 0
            knob_tail = []
            first_images: dict[str, np.ndarray] = {}
            last_images: dict[str, np.ndarray] = {}
            for state, knob_angle, action in sim.expert_frames():
                frame = {"observation.state": state, "action": action, "task": TASK}
                images = cameras.capture(sim)
                for sensor, image in images.items():
                    expected = (args.height, args.width, 3)
                    if image.shape != expected:
                        raise RuntimeError(f"Sensor {sensor} shape {image.shape} != {expected}")
                    frame[f"observation.images.{sensor}"] = image
                    first_images.setdefault(sensor, image.copy())
                    last_images[sensor] = image
                dataset.add_frame(frame)
                frames += 1
                knob_tail = (knob_tail + [knob_angle])[-10:]
            # a static render stream means TF poses never reached the renderer;
            # refuse to finalize unusable training data
            motion = {
                sensor: float(np.mean(np.abs(
                    last_images[sensor].astype(np.int16) - first_images[sensor].astype(np.int16)
                )))
                for sensor in first_images
            }
            print(f"image motion (mean abs first-vs-last): {motion}", flush=True)
            if all(value < 0.5 for value in motion.values()):
                raise RuntimeError(
                    f"Rendered images are static ({motion}); renderer did not apply /tf poses"
                )
            held = min(abs(a) for a in knob_tail)
            success = held >= SUCCESS_ANGLE and np.all(np.isfinite(sim.read_state()))
            metrics.append({
                "episode": episode, "frames": frames,
                "knob_final_rad": knob_tail[-1], "knob_held_min_rad": held,
                "success": bool(success),
            })
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--episodes", type=int, default=1)
    parser.add_argument("--sensors", default="front,closeup")
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=240)
    parser.add_argument("--frame-timeout", type=float, default=180.0)
    parser.add_argument("--use-videos", action="store_true")
    return generate(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
