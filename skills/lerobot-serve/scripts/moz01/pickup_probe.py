#!/usr/bin/env python3
"""Replay the cube-pick expert trajectory in standalone ovphysx."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from ovphysx import PhysX, TensorType

from control import WRIST_HORIZONTAL, set_grip, set_open


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("--fps", type=float, default=60.0)
    parser.add_argument("--lift-threshold", type=float, default=0.05)
    parser.add_argument("--wrist-roll", type=float, default=WRIST_HORIZONTAL)
    parser.add_argument("--wrist-joint", type=int, choices=(4, 5, 6), default=4)
    parser.add_argument("--cube-x", type=float, default=0.7825)
    parser.add_argument("--cube-y", type=float, default=0.3815)
    parser.add_argument("--cube-z", type=float, default=0.695)
    parser.add_argument("--approach-j1", type=float, default=-0.18)
    parser.add_argument("--approach-j0", type=float, default=0.12)
    parser.add_argument("--approach-j2", type=float, default=-0.38)
    parser.add_argument("--approach-j3", type=float, default=0.22)
    parser.add_argument("--pregrasp-j0", type=float, default=-0.10)
    parser.add_argument("--pregrasp-j1", type=float, default=-0.10)
    parser.add_argument("--pregrasp-j3", type=float, default=0.75)
    parser.add_argument("--grip-angle", type=float, default=0.30)
    parser.add_argument("--open-angle", type=float, default=0.30)
    parser.add_argument("--lift-joint", type=int, choices=range(7), default=3)
    parser.add_argument("--lift-delta", type=float, default=0.30)
    parser.add_argument("--remove-platform", action="store_true")
    parser.add_argument("--trajectory-out", type=Path)
    return parser.parse_args()


def smoothstep(value: float) -> float:
    return value * value * (3.0 - 2.0 * value)


def main() -> int:
    args = parse_args()
    physx = PhysX(device="cpu")
    bindings = []
    try:
        _, op = physx.add_usd(str(args.scene.resolve()))
        physx.wait_op(op)
        physx.step_sync(1.0 / args.fps, 0.0)

        def bind(pattern: str, tensor_type: TensorType):
            result = physx.create_tensor_binding(pattern, tensor_type=tensor_type, raise_if_empty=True)
            bindings.append(result)
            return result

        position = bind("/World/**", TensorType.ARTICULATION_DOF_POSITION)
        target = bind("/World/**", TensorType.ARTICULATION_DOF_POSITION_TARGET)
        link_pose = bind("/World/**", TensorType.ARTICULATION_LINK_POSE)
        cube_pose = bind("/World/TargetCube", TensorType.RIGID_BODY_POSE)
        platform_pose = bind("/World/Table/SideShelf", TensorType.RIGID_BODY_POSE)
        cube_velocity = bind("/World/TargetCube", TensorType.RIGID_BODY_VELOCITY)
        state = np.empty(position.shape, dtype=np.float32)
        command = np.empty(target.shape, dtype=np.float32)
        cube = np.empty(cube_pose.shape, dtype=np.float32)
        platform = np.empty(platform_pose.shape, dtype=np.float32)
        stopped_cube = np.zeros(cube_velocity.shape, dtype=np.float32)
        links = np.empty(link_pose.shape, dtype=np.float32)
        position.read(state)
        target.read(command)
        names = list(position.dof_names)
        index = {name: i for i, name in enumerate(names)}
        body_index = {name: i for i, name in enumerate(link_pose.body_names)}
        sim_time = 1.0 / args.fps
        phase = "settle"
        sample_counter = 0
        trajectory_links: list[np.ndarray] = []
        trajectory_cube: list[np.ndarray] = []
        trajectory_phases: list[str] = []

        def step(count: int = 1) -> None:
            nonlocal sim_time, sample_counter
            for _ in range(count):
                physx.step_sync(1.0 / args.fps, sim_time)
                sim_time += 1.0 / args.fps
                if args.trajectory_out is not None and sample_counter % 4 == 0:
                    link_pose.read(links)
                    cube_pose.read(cube)
                    trajectory_links.append(links[0, :, :3].copy())
                    trajectory_cube.append(cube[0, :3].copy())
                    trajectory_phases.append(phase)
                sample_counter += 1

        def read() -> tuple[np.ndarray, np.ndarray]:
            position.read(state)
            cube_pose.read(cube)
            return state.copy(), cube.copy()

        def hand_snapshot() -> dict[str, list[float]]:
            link_pose.read(links)
            return {
                name: links[0, body_index[name], :3].astype(float).tolist()
                for name in ("right_gripper_base_link",
                             "right_hand_narrow3_Link", "right_hand_wide3_Link",
                             "left_hand_narrow3_Link", "left_hand_wide3_Link")
            }

        def fingertip_snapshot() -> dict[str, list[float]]:
            link_pose.read(links)
            offsets = {
                # Centroids of the USD-authored fingertip convex hulls.
                "right_hand_narrow3_Link": np.array([0.04395, -0.0194, 0.0]),
                "right_hand_wide3_Link": np.array([0.0439, 0.0207, 0.0]),
            }
            result = {}
            for name, offset in offsets.items():
                pose = links[0, body_index[name]]
                xyz = pose[:3]
                q_xyz, q_w = pose[3:6], pose[6]
                twice_cross = 2.0 * np.cross(q_xyz, offset)
                rotated = offset + q_w * twice_cross + np.cross(q_xyz, twice_cross)
                result[name] = (xyz + rotated).astype(float).tolist()
            return result

        def move(goal: np.ndarray, steps: int) -> None:
            start, _ = read()
            for frame in range(steps):
                blend = smoothstep((frame + 1) / steps)
                command[:] = start + (goal - start) * blend
                target.write(command)
                step(2)

        command[:] = state
        target.write(command)
        step(120)
        _, settled_cube = read()
        settled_z = float(settled_cube[0, 2])

        raise_goal = state.copy()
        for prefix, values in (
            ("RightArm", [0.15, -0.30, -0.60, 0.50, 0.0, 0.0, 0.0]),
            ("LeftArm", [-0.15, 0.30, -0.60, -0.50, 0.0, 0.0, 0.0]),
        ):
            for joint, value in enumerate(values):
                raise_goal[0, index[f"{prefix}_{joint}"]] = value
        raise_goal[0, index[f"RightArm_{args.wrist_joint}"]] = args.wrist_roll
        set_open(raise_goal[0], index, args.open_angle)
        phase = "raise"
        move(raise_goal, 120)

        pregrasp_goal = raise_goal.copy()
        pregrasp_values = [args.pregrasp_j0, args.pregrasp_j1, args.approach_j2,
                           args.pregrasp_j3, 0.0, 0.0, 0.0]
        for joint, value in enumerate(pregrasp_values):
            pregrasp_goal[0, index[f"RightArm_{joint}"]] = value
        pregrasp_goal[0, index[f"RightArm_{args.wrist_joint}"]] = args.wrist_roll
        phase = "pregrasp"
        move(pregrasp_goal, 100)
        raise_hands = hand_snapshot()

        platform[0] = np.array([args.cube_x, args.cube_y, 0.64, 0.0, 0.0, 0.0, 1.0], dtype=np.float32)
        platform_pose.write(platform)

        cube[0] = np.array(
            [args.cube_x, args.cube_y, args.cube_z, 0.0, 0.0, 0.0, 1.0],
            dtype=np.float32,
        )
        cube_pose.write(cube)
        cube_velocity.write(stopped_cube)
        step(30)
        _, stationary_cube = read()
        settled_z = float(stationary_cube[0, 2])

        approach_goal = raise_goal.copy()
        for prefix, values in (
            ("RightArm", [args.approach_j0, args.approach_j1, args.approach_j2,
                          args.approach_j3, 0.0, 0.0, 0.0]),
            ("LeftArm", [-0.12, 0.18, -0.38, -0.22, 0.0, 0.0, 0.0]),
        ):
            for joint, value in enumerate(values):
                approach_goal[0, index[f"{prefix}_{joint}"]] = value
        approach_goal[0, index[f"RightArm_{args.wrist_joint}"]] = args.wrist_roll
        phase = "approach"
        move(approach_goal, 100)
        approach_state, _ = read()
        approach_hands = hand_snapshot()
        link_pose.read(links)
        approach_quaternions = {
            name: links[0, body_index[name], 3:7].astype(float).tolist()
            for name in ("right_hand_narrow3_Link", "right_hand_wide3_Link")
        }
        approach_fingertips = fingertip_snapshot()
        _, preclose_cube = read()
        preclose_translation = float(
            np.linalg.norm(preclose_cube[0, :3] - stationary_cube[0, :3])
        )

        grip_goal = approach_goal.copy()
        set_grip(grip_goal[0], index, args.grip_angle)
        phase = "grip"
        move(grip_goal, 120)
        step(40)
        gripped_state, _ = read()
        gripped_hands = hand_snapshot()
        gripped_fingertips = fingertip_snapshot()
        _, gripped_cube = read()
        if args.remove_platform:
            platform[0] = np.array([0.50, 0.40, 0.64, 0.0, 0.0, 0.0, 1.0], dtype=np.float32)
            platform_pose.write(platform)
            step(5)

        lift_goal = grip_goal.copy()
        lift_goal[0, index[f"RightArm_{args.lift_joint}"]] += args.lift_delta
        lift_goal[0, index["LeftArm_3"]] -= 0.30
        phase = "lift"
        move(lift_goal, 80)

        heights = []
        phase = "hold"
        for _ in range(120):
            target.write(lift_goal)
            step()
            _, pose = read()
            heights.append(float(pose[0, 2]))
        final_state, final_cube = read()
        final_fingertips = fingertip_snapshot()
        minimum_hold_z = min(heights[-60:])
        report = {
            "scene": str(args.scene.resolve()),
            "dof_count": len(names),
            "settled_cube_z": settled_z,
            "stationary_cube_pose": stationary_cube[0].astype(float).tolist(),
            "raise_hand_positions": raise_hands,
            "preclose_cube_pose": preclose_cube[0].astype(float).tolist(),
            "preclose_translation": preclose_translation,
            "final_cube_pose": final_cube[0].astype(float).tolist(),
            "lift_height": float(final_cube[0, 2] - settled_z),
            "minimum_hold_lift": float(minimum_hold_z - settled_z),
            "approach_hand_positions": approach_hands,
            "approach_gripper_positions": {
                name: float(approach_state[0, column])
                for name, column in index.items() if name.startswith("right_hand_")
            },
            "approach_arm_positions": {
                name: float(approach_state[0, column])
                for name, column in index.items() if name.startswith("RightArm_")
            },
            "approach_fingertip_positions": approach_fingertips,
            "approach_hand_quaternions": approach_quaternions,
            "wrist_roll": args.wrist_roll,
            "wrist_joint": args.wrist_joint,
            "gripped_hand_positions": gripped_hands,
            "gripped_gripper_positions": {
                name: float(gripped_state[0, column])
                for name, column in index.items() if name.startswith("right_hand_")
            },
            "gripped_fingertip_positions": gripped_fingertips,
            "gripped_cube_pose": gripped_cube[0].astype(float).tolist(),
            "final_hand_positions": hand_snapshot(),
            "success_threshold": args.lift_threshold,
            "success": (
                preclose_translation <= 0.005
                and minimum_hold_z - settled_z >= args.lift_threshold
            ),
            "finite": bool(np.all(np.isfinite(final_state)) and np.all(np.isfinite(final_cube))),
        }
        print(json.dumps(report, indent=2))
        narrow = np.asarray(approach_hands["right_hand_narrow3_Link"])
        wide = np.asarray(approach_hands["right_hand_wide3_Link"])
        tip_narrow = np.asarray(approach_fingertips["right_hand_narrow3_Link"])
        tip_wide = np.asarray(approach_fingertips["right_hand_wide3_Link"])
        grip_tip_narrow = np.asarray(gripped_fingertips["right_hand_narrow3_Link"])
        grip_tip_wide = np.asarray(gripped_fingertips["right_hand_wide3_Link"])
        final_tip_narrow = np.asarray(final_fingertips["right_hand_narrow3_Link"])
        final_tip_wide = np.asarray(final_fingertips["right_hand_wide3_Link"])
        print("PROBE_SUMMARY=" + json.dumps({
            "pregrasp_center": (
                (np.asarray(raise_hands["right_hand_narrow3_Link"])
                 + np.asarray(raise_hands["right_hand_wide3_Link"])) * 0.5
            ).tolist(),
            "center": ((narrow + wide) * 0.5).tolist(),
            "finger_axis": (narrow - wide).tolist(),
            "fingertip_center": ((tip_narrow + tip_wide) * 0.5).tolist(),
            "fingertip_axis": (tip_narrow - tip_wide).tolist(),
            "gripped_fingertip_center": ((grip_tip_narrow + grip_tip_wide) * 0.5).tolist(),
            "gripped_fingertip_axis": (grip_tip_narrow - grip_tip_wide).tolist(),
            "gripped_cube": gripped_cube[0, :3].astype(float).tolist(),
            "final_fingertip_center": ((final_tip_narrow + final_tip_wide) * 0.5).tolist(),
            "link_quaternions": approach_quaternions,
            "stationary_cube": stationary_cube[0, :3].astype(float).tolist(),
            "preclose_cube": preclose_cube[0, :3].astype(float).tolist(),
            "preclose_translation": preclose_translation,
            "minimum_hold_lift": float(minimum_hold_z - settled_z),
            "success": report["success"],
        }))
        if args.trajectory_out is not None:
            args.trajectory_out.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(
                args.trajectory_out,
                link_positions=np.asarray(trajectory_links, dtype=np.float32),
                cube_positions=np.asarray(trajectory_cube, dtype=np.float32),
                body_names=np.asarray(link_pose.body_names),
                phases=np.asarray(trajectory_phases),
                fps=np.asarray(args.fps / 4.0, dtype=np.float32),
            )
            print(f"TRAJECTORY_SAVED={args.trajectory_out.resolve()}")
        return 0 if report["success"] and report["finite"] else 2
    finally:
        for binding in reversed(bindings):
            binding.destroy()
        physx.release()


if __name__ == "__main__":
    raise SystemExit(main())
