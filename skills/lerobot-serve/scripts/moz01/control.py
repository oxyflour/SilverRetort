"""Deterministic MOZ01 wrist and imported four-bar control mapping."""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np


WRIST_JOINT = "RightArm_4"
WRIST_HORIZONTAL = -np.pi / 2.0
OPEN_ANGLE = 0.30
GRIP_ANGLE = 0.30

RAISE_RIGHT = (0.15, -0.30, -0.60, 0.50, WRIST_HORIZONTAL, 0.0, 0.0)
RAISE_LEFT = (-0.15, 0.30, -0.60, -0.50, 0.0, 0.0, 0.0)
PREGRASP_RIGHT = (-0.10, -0.10, -0.38, 0.75, WRIST_HORIZONTAL, 0.0, 0.0)
APPROACH_RIGHT = (0.12, -0.18, -0.38, 0.22, WRIST_HORIZONTAL, 0.0, 0.0)
APPROACH_LEFT = (-0.12, 0.18, -0.38, -0.22, 0.0, 0.0, 0.0)


def set_four_bar(goal: np.ndarray, index: Mapping[str, int], branch: str, crank: float) -> None:
    """Set the open-chain import to the equivalent closed-linkage configuration."""
    prefix = f"right_hand_{branch}"
    goal[index[f"{prefix}1_joint"]] = crank
    goal[index[f"{prefix}2_joint"]] = -crank
    goal[index[f"{prefix}3_joint"]] = 0.0
    goal[index[f"{prefix}_loop_joint"]] = crank


def set_open(goal: np.ndarray, index: Mapping[str, int], angle: float = OPEN_ANGLE) -> None:
    set_four_bar(goal, index, "narrow", -angle)
    set_four_bar(goal, index, "wide", angle)


def set_grip(goal: np.ndarray, index: Mapping[str, int], angle: float = GRIP_ANGLE) -> None:
    set_four_bar(goal, index, "narrow", angle)
    set_four_bar(goal, index, "wide", -angle)


def normalize_action(action: np.ndarray, index: Mapping[str, int]) -> np.ndarray:
    """Force wrist orientation and derive all follower targets from the two crank targets."""
    result = np.asarray(action, dtype=np.float32).copy()
    result[index[WRIST_JOINT]] = WRIST_HORIZONTAL
    for branch in ("narrow", "wide"):
        prefix = f"right_hand_{branch}"
        crank = float(result[index[f"{prefix}1_joint"]])
        set_four_bar(result, index, branch, crank)
    return result


def expand_named_positions(values: Mapping[str, float]) -> dict[str, float]:
    """Expand a partial ROS position command using the MOZ01 coupling profile."""
    result = {name: float(value) for name, value in values.items()}
    result[WRIST_JOINT] = float(WRIST_HORIZONTAL)
    for branch in ("narrow", "wide"):
        prefix = f"right_hand_{branch}"
        crank_name = f"{prefix}1_joint"
        if crank_name not in result:
            continue
        crank = result[crank_name]
        result[f"{prefix}2_joint"] = -crank
        result[f"{prefix}3_joint"] = 0.0
        result[f"{prefix}_loop_joint"] = crank
    return result
