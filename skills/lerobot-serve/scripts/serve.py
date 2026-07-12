#!/usr/bin/env python3
"""Run a USD articulation in standalone ovphysx and bridge it to ROS 2."""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import time
from pathlib import Path

import numpy as np
from ovphysx import PhysX, TensorType


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("usd", type=Path, help="USD scene containing a physics articulation")
    parser.add_argument("--articulation", default="/World/**", help="ovphysx articulation prim pattern")
    parser.add_argument("--fps", type=float, default=60.0, help="simulation and publish frequency")
    parser.add_argument("--device", choices=("cpu", "gpu"), default="cpu")
    parser.add_argument("--node-name", default="lerobot_ovphysx")
    parser.add_argument("--namespace", default="/lerobot")
    parser.add_argument("--world-frame", default="world")
    parser.add_argument(
        "--lock-root", action="store_true",
        help="hold floating articulation roots at their initial world pose",
    )
    parser.add_argument("--inspect", action="store_true", help="load USD, print metadata, then exit")
    parser.add_argument("--no-clock", action="store_true", help="do not publish ROS simulation time")
    parser.add_argument(
        "--control-profile", choices=("moz01",),
        help="apply a robot-specific command coupling profile",
    )
    return parser.parse_args()


def frame_name(value: str) -> str:
    value = value.strip("/").replace("::", "/")
    return re.sub(r"[^A-Za-z0-9_/]", "_", value) or "robot"


class Simulation:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.physx = PhysX(device=args.device)
        _, op = self.physx.add_usd(str(args.usd.resolve()))
        self.physx.wait_op(op)
        self.physx.step_sync(1.0 / args.fps, 0.0)
        self.bindings = []
        self.position = self._binding(TensorType.ARTICULATION_DOF_POSITION)
        self.velocity = self._binding(TensorType.ARTICULATION_DOF_VELOCITY)
        self.position_target = self._binding(TensorType.ARTICULATION_DOF_POSITION_TARGET)
        self.velocity_target = self._binding(TensorType.ARTICULATION_DOF_VELOCITY_TARGET)
        self.effort = self._binding(TensorType.ARTICULATION_DOF_ACTUATION_FORCE)
        self.root_pose = self._binding(TensorType.ARTICULATION_ROOT_POSE)
        self.root_velocity = (
            self._binding(TensorType.ARTICULATION_ROOT_VELOCITY)
            if getattr(args, "lock_root", False) else None
        )
        self.link_pose = self._binding(TensorType.ARTICULATION_LINK_POSE)
        self.positions = np.empty(self.position.shape, dtype=np.float32)
        self.velocities = np.empty(self.velocity.shape, dtype=np.float32)
        self.efforts = np.empty(self.effort.shape, dtype=np.float32)
        self.roots = np.empty(self.root_pose.shape, dtype=np.float32)
        self.root_velocities = (
            np.zeros(self.root_velocity.shape, dtype=np.float32)
            if self.root_velocity is not None else None
        )
        self.links = np.empty(self.link_pose.shape, dtype=np.float32)
        self.position_targets = np.empty(self.position_target.shape, dtype=np.float32)
        self.velocity_targets = np.empty(self.velocity_target.shape, dtype=np.float32)
        self.force_targets = np.empty(self.effort.shape, dtype=np.float32)
        self.position_target.read(self.position_targets)
        self.velocity_target.read(self.velocity_targets)
        self.effort.read(self.force_targets)
        self.root_pose.read(self.roots)
        self.initial_roots = self.roots.copy()
        self.sim_time = 1.0 / args.fps

    def _binding(self, tensor_type: TensorType):
        binding = self.physx.create_tensor_binding(
            self.args.articulation, tensor_type=tensor_type, raise_if_empty=True
        )
        self.bindings.append(binding)
        return binding

    @property
    def roots_paths(self) -> list[str]:
        return self.position.prim_paths

    def metadata(self) -> dict:
        return {
            "usd": str(self.args.usd.resolve()),
            "articulation_pattern": self.args.articulation,
            "articulation_roots": self.roots_paths,
            "dof_names": self.position.dof_names,
            "body_names": self.link_pose.body_names,
            "fixed_base": self.position.is_fixed_base,
            "root_locked": getattr(self.args, "lock_root", False),
            "fps": self.args.fps,
            "device": self.args.device,
            "control_profile": getattr(self.args, "control_profile", None),
        }

    def read(self) -> None:
        self.position.read(self.positions)
        self.velocity.read(self.velocities)
        self.effort.read(self.efforts)
        self.root_pose.read(self.roots)
        self.link_pose.read(self.links)

    def step(self) -> None:
        if getattr(self.args, "lock_root", False):
            self.root_pose.write(self.initial_roots)
            self.root_velocity.write(self.root_velocities)
        self.physx.step_sync(1.0 / self.args.fps, self.sim_time)
        if getattr(self.args, "lock_root", False):
            self.root_pose.write(self.initial_roots)
            self.root_velocity.write(self.root_velocities)
        self.sim_time += 1.0 / self.args.fps

    def command(self, names: list[str], position: list[float], velocity: list[float], effort: list[float]) -> None:
        multiple = len(self.roots_paths) > 1
        lookup = {}
        for row, root in enumerate(self.roots_paths):
            for col, name in enumerate(self.position.dof_names):
                lookup[f"{root}::{name}" if multiple else name] = (row, col)
        position_names = names
        if getattr(self.args, "control_profile", None) == "moz01" and position:
            from moz01.control import expand_named_positions

            expanded = expand_named_positions(dict(zip(names, position, strict=False)))
            position_names, position = list(expanded), list(expanded.values())
        for command_names, values, target, binding in (
            (position_names, position, self.position_targets, self.position_target),
            (names, velocity, self.velocity_targets, self.velocity_target),
            (names, effort, self.force_targets, self.effort),
        ):
            changed = False
            for name, value in zip(command_names, values, strict=False):
                index = lookup.get(name)
                if index is not None:
                    target[index] = value
                    changed = True
            if changed:
                binding.write(target)

    def close(self) -> None:
        for binding in reversed(self.bindings):
            binding.destroy()
        self.physx.release()


def ros_main(args: argparse.Namespace, sim: Simulation) -> None:
    try:
        import rclpy
        from builtin_interfaces.msg import Time as TimeMsg
        from geometry_msgs.msg import PoseStamped, TransformStamped
        from rclpy.node import Node
        from rclpy.qos import DurabilityPolicy, QoSProfile
        from rosgraph_msgs.msg import Clock
        from sensor_msgs.msg import JointState
        from std_msgs.msg import String
        from tf2_msgs.msg import TFMessage
    except ImportError as exc:
        raise SystemExit(f"ROS 2 Python packages are unavailable in this interpreter: {exc}") from exc

    rclpy.init()
    node = Node(args.node_name)
    ns = args.namespace.rstrip("/")
    joint_pub = node.create_publisher(JointState, f"{ns}/joint_states", 10)
    pose_pub = node.create_publisher(PoseStamped, f"{ns}/root_pose", 10)
    tf_pub = node.create_publisher(TFMessage, "/tf", 10)
    clock_pub = None if args.no_clock else node.create_publisher(Clock, "/clock", 10)
    metadata_qos = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
    metadata_pub = node.create_publisher(String, f"{ns}/metadata", metadata_qos)

    def on_command(msg: JointState) -> None:
        sim.command(list(msg.name), list(msg.position), list(msg.velocity), list(msg.effort))

    node.create_subscription(JointState, f"{ns}/command", on_command, 10)
    metadata_pub.publish(String(data=json.dumps(sim.metadata(), ensure_ascii=False)))
    node.get_logger().info(json.dumps(sim.metadata(), ensure_ascii=False))
    stopping = False

    def request_stop(*_unused) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    period = 1.0 / args.fps
    next_tick = time.perf_counter()
    multiple = len(sim.roots_paths) > 1
    try:
        while rclpy.ok() and not stopping:
            rclpy.spin_once(node, timeout_sec=0.0)
            sim.step()
            sim.read()
            stamp = node.get_clock().now().to_msg()
            names = []
            for root in sim.roots_paths:
                names.extend([f"{root}::{name}" if multiple else name for name in sim.position.dof_names])
            joint_state = JointState()
            joint_state.header.stamp = stamp
            joint_state.name = names
            joint_state.position = sim.positions.reshape(-1).astype(float).tolist()
            joint_state.velocity = sim.velocities.reshape(-1).astype(float).tolist()
            joint_state.effort = sim.efforts.reshape(-1).astype(float).tolist()
            joint_pub.publish(joint_state)
            root = sim.roots[0]
            pose = PoseStamped()
            pose.header.stamp, pose.header.frame_id = stamp, args.world_frame
            pose.pose.position.x, pose.pose.position.y, pose.pose.position.z = map(float, root[:3])
            pose.pose.orientation.x, pose.pose.orientation.y, pose.pose.orientation.z, pose.pose.orientation.w = map(float, root[3:])
            pose_pub.publish(pose)
            transforms = []
            for row, root_path in enumerate(sim.roots_paths):
                prefix = frame_name(root_path)
                for col, body in enumerate(sim.link_pose.body_names):
                    value = sim.links[row, col]
                    transform = TransformStamped()
                    transform.header.stamp, transform.header.frame_id = stamp, args.world_frame
                    transform.child_frame_id = f"{prefix}/{frame_name(body)}"
                    transform.transform.translation.x, transform.transform.translation.y, transform.transform.translation.z = map(float, value[:3])
                    transform.transform.rotation.x, transform.transform.rotation.y, transform.transform.rotation.z, transform.transform.rotation.w = map(float, value[3:])
                    transforms.append(transform)
            tf_pub.publish(TFMessage(transforms=transforms))
            if clock_pub is not None:
                seconds = int(sim.sim_time)
                clock_pub.publish(Clock(clock=TimeMsg(sec=seconds, nanosec=int((sim.sim_time - seconds) * 1e9))))
            next_tick += period
            delay = next_tick - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                next_tick = time.perf_counter()
    finally:
        node.destroy_node()
        rclpy.shutdown()


def main() -> int:
    args = parse_args()
    if not args.usd.is_file():
        raise SystemExit(f"USD file does not exist: {args.usd}")
    if args.fps <= 0:
        raise SystemExit("--fps must be positive")
    sim = Simulation(args)
    try:
        if args.inspect:
            sim.read()
            data = sim.metadata() | {
                "initial_positions": sim.positions.astype(float).tolist(),
                "initial_root_poses": sim.roots.astype(float).tolist(),
            }
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            ros_main(args, sim)
    finally:
        sim.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
