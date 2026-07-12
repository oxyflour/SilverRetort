#!/usr/bin/env python3
"""Stress a robot USD in standalone ovphysx and reject unstable simulation state."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from ovphysx import PhysX, TensorType


STATE_TYPES = {
    "dof_position": TensorType.ARTICULATION_DOF_POSITION,
    "dof_velocity": TensorType.ARTICULATION_DOF_VELOCITY,
    "dof_effort": TensorType.ARTICULATION_DOF_ACTUATION_FORCE,
    "root_pose": TensorType.ARTICULATION_ROOT_POSE,
    "root_velocity": TensorType.ARTICULATION_ROOT_VELOCITY,
    "link_pose": TensorType.ARTICULATION_LINK_POSE,
    "link_velocity": TensorType.ARTICULATION_LINK_VELOCITY,
}

PROPERTY_TYPES = {
    "dof_limit": TensorType.ARTICULATION_DOF_LIMIT,
    "body_mass": TensorType.ARTICULATION_BODY_MASS,
    "body_inertia": TensorType.ARTICULATION_BODY_INERTIA,
}


class VerificationFailure(RuntimeError):
    def __init__(self, kind: str, **details):
        self.kind = kind
        self.details = details
        super().__init__(f"{kind}: {details}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("usd", type=Path)
    parser.add_argument("--articulation", default="/World/**")
    parser.add_argument("--steps", type=int, default=1800)
    parser.add_argument("--fps", type=float, default=60.0)
    parser.add_argument("--amplitude", type=float, default=0.2)
    parser.add_argument("--period", type=float, default=4.0)
    parser.add_argument("--max-root-drift", type=float, default=5.0)
    parser.add_argument("--device", choices=("cpu", "gpu"), default="cpu")
    parser.add_argument("--lock-root", action="store_true")
    parser.add_argument("--no-stress", action="store_true")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def check_args(args: argparse.Namespace) -> None:
    if not args.usd.is_file():
        raise SystemExit(f"USD file does not exist: {args.usd}")
    for name in ("steps", "fps", "period", "max_root_drift"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} must be positive")
    if args.amplitude < 0:
        raise SystemExit("--amplitude must be non-negative")


def first_bad(array: np.ndarray) -> list[int] | None:
    bad = np.argwhere(~np.isfinite(array))
    return bad[0].astype(int).tolist() if len(bad) else None


def require_finite(name: str, array: np.ndarray, step: int) -> None:
    index = first_bad(array)
    if index is not None:
        value = array[tuple(index)]
        raise VerificationFailure(
            "non_finite", tensor=name, step=step, index=index, value=str(value)
        )


def read_binding(binding) -> np.ndarray:
    value = np.empty(binding.shape, dtype=np.float32)
    binding.read(value)
    return value


def bounded_targets(initial: np.ndarray, limits: np.ndarray, offset: np.ndarray) -> np.ndarray:
    target = initial + offset
    lower, upper = limits[..., 0], limits[..., 1]
    finite_lower, finite_upper = np.isfinite(lower), np.isfinite(upper)
    target = np.where(finite_lower, np.maximum(target, lower + 1e-4), target)
    target = np.where(finite_upper, np.minimum(target, upper - 1e-4), target)
    return target.astype(np.float32)


def verify(args: argparse.Namespace) -> dict:
    sdk = PhysX(device=args.device)
    bindings = []
    try:
        _, operation = sdk.add_usd(str(args.usd.resolve()))
        sdk.wait_op(operation)
        sdk.step_sync(1.0 / args.fps, 0.0)

        resolved_pattern = args.articulation

        def bind(tensor_type: TensorType):
            value = sdk.create_tensor_binding(
                resolved_pattern, tensor_type=tensor_type, raise_if_empty=True
            )
            bindings.append(value)
            return value

        position = bind(TensorType.ARTICULATION_DOF_POSITION)
        roots = position.prim_paths
        if len(roots) == 1:
            resolved_pattern = roots[0]
        state = {"dof_position": position}
        state.update({
            name: bind(kind) for name, kind in STATE_TYPES.items() if name != "dof_position"
        })
        properties = {name: bind(kind) for name, kind in PROPERTY_TYPES.items()}
        target_binding = bind(TensorType.ARTICULATION_DOF_POSITION_TARGET)
        arrays = {name: read_binding(binding) for name, binding in state.items()}
        prop_arrays = {name: read_binding(binding) for name, binding in properties.items()}
        for name, value in arrays.items():
            require_finite(name, value, 0)
        require_finite("body_mass", prop_arrays["body_mass"], 0)
        require_finite("body_inertia", prop_arrays["body_inertia"], 0)
        if np.any(prop_arrays["body_mass"] <= 0):
            index = np.argwhere(prop_arrays["body_mass"] <= 0)[0].astype(int).tolist()
            raise VerificationFailure("non_positive_mass", index=index)

        initial_dof = arrays["dof_position"].copy()
        initial_root = arrays["root_pose"].copy()
        zero_root_velocity = np.zeros_like(arrays["root_velocity"])
        phases = np.linspace(0.0, math.tau, initial_dof.shape[-1], endpoint=False)
        max_drift = 0.0
        maximums = {name: float(np.max(np.abs(value))) for name, value in arrays.items()}

        for step in range(1, args.steps + 1):
            elapsed = step / args.fps
            if not args.no_stress:
                wave = np.sin(math.tau * elapsed / args.period + phases)
                offsets = np.broadcast_to(args.amplitude * wave, initial_dof.shape)
                target_binding.write(bounded_targets(initial_dof, prop_arrays["dof_limit"], offsets))
            if args.lock_root:
                state["root_pose"].write(initial_root)
                state["root_velocity"].write(zero_root_velocity)
            sdk.step_sync(1.0 / args.fps, elapsed)
            if args.lock_root:
                state["root_pose"].write(initial_root)
                state["root_velocity"].write(zero_root_velocity)

            for name, binding in state.items():
                binding.read(arrays[name])
                require_finite(name, arrays[name], step)
                maximums[name] = max(maximums[name], float(np.max(np.abs(arrays[name]))))
            drift = np.linalg.norm(arrays["root_pose"][..., :3] - initial_root[..., :3], axis=-1)
            max_drift = max(max_drift, float(np.max(drift)))
            if max_drift > args.max_root_drift:
                index = np.unravel_index(int(np.argmax(drift)), drift.shape)
                raise VerificationFailure(
                    "root_drift", step=step, articulation=list(map(int, index)),
                    drift=max_drift, limit=args.max_root_drift,
                )

        return {
            "status": "passed",
            "usd": str(args.usd.resolve()),
            "articulation_pattern": args.articulation,
            "articulation_roots": state["dof_position"].prim_paths,
            "dof_names": state["dof_position"].dof_names,
            "body_names": state["link_pose"].body_names,
            "fixed_base": state["dof_position"].is_fixed_base,
            "root_locked": args.lock_root,
            "stress": not args.no_stress,
            "steps": args.steps,
            "simulated_seconds": args.steps / args.fps,
            "max_root_drift": max_drift,
            "max_abs": maximums,
        }
    finally:
        for binding in reversed(bindings):
            binding.destroy()
        sdk.release()


def worker_main(args: argparse.Namespace) -> int:
    try:
        result = verify(args)
    except VerificationFailure as exc:
        result = {
            "status": "failed", "usd": str(args.usd.resolve()),
            "kind": exc.kind, **exc.details,
        }
        print("VERIFY_JSON=" + json.dumps(result, ensure_ascii=False))
        return 1
    print("VERIFY_JSON=" + json.dumps(result, ensure_ascii=False))
    return 0


def orchestrate() -> int:
    command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    native_log = completed.stdout + "\n" + completed.stderr
    marker = re.search(r"VERIFY_JSON=(\{[^\r\n]*\})", native_log)
    if marker is None:
        print(native_log, file=sys.stderr)
        raise RuntimeError("ovphysx verification worker did not return structured JSON")
    result = json.loads(marker.group(1))
    unresolved = sorted(set(re.findall(r"Could not open asset @([^@]+)@", native_log)))
    closed = sorted(set(re.findall(r"RigidBody \(([^)]+)\).*?closed articulation", native_log)))
    diagnostics = {}
    if unresolved:
        diagnostics["unresolved_assets"] = unresolved
    if closed:
        diagnostics["closed_articulation_bodies"] = closed
    if diagnostics:
        result["native_diagnostics"] = diagnostics
        if result["status"] == "passed":
            result["status"] = "passed_with_warnings"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return completed.returncode


def main() -> int:
    args = parse_args()
    check_args(args)
    return worker_main(args) if args.worker else orchestrate()


if __name__ == "__main__":
    sys.exit(main())
