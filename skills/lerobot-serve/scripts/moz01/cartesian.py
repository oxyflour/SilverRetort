"""Cartesian control of the two USD-authored MOZ01 fingertip hulls."""

from __future__ import annotations

from typing import Protocol

import numpy as np
from ovphysx import TensorType


HULL_CENTROIDS = {
    "right_hand_narrow3_Link": np.array([0.04395, -0.0194, 0.0]),
    "right_hand_wide3_Link": np.array([0.0439, 0.0207, 0.0]),
}


class SimLike(Protocol):
    names: list[str]
    index: dict[str, int]
    link_pose: object

    def bind(self, pattern: str, tensor_type: TensorType): ...
    def read_links(self) -> np.ndarray: ...
    def read_state(self) -> np.ndarray: ...
    def write_action(self, action: np.ndarray, physics_steps: int = 3) -> np.ndarray: ...


def transform_point(pose: np.ndarray, local_point: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return a local point in world space and its rotated link-relative offset."""
    q_xyz = pose[3:6]
    q_w = pose[6]
    twice_cross = 2.0 * np.cross(q_xyz, local_point)
    rotated = local_point + q_w * twice_cross + np.cross(q_xyz, twice_cross)
    return pose[:3] + rotated, rotated


def cross_matrix(vector: np.ndarray) -> np.ndarray:
    x, y, z = vector
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]])


class FingertipIK:
    """Damped least-squares IK for the mean of the two collision hulls."""

    def __init__(self, sim: SimLike):
        self.sim = sim
        self.jacobian = sim.bind("/World/**", TensorType.ARTICULATION_JACOBIAN)
        self.values = np.empty(self.jacobian.shape, dtype=np.float32)
        self.body_index = {name: i for i, name in enumerate(sim.link_pose.body_names)}
        self.arm_columns = [sim.index[f"RightArm_{joint}"] for joint in (0, 1, 2, 3, 5, 6)]

    def positions(self) -> dict[str, np.ndarray]:
        links = self.sim.read_links()
        return {
            name: transform_point(links[self.body_index[name]], offset)[0]
            for name, offset in HULL_CENTROIDS.items()
        }

    def center(self) -> np.ndarray:
        return np.mean(list(self.positions().values()), axis=0)

    def move_to(
        self,
        target: np.ndarray,
        *,
        tolerance: float = 0.002,
        max_iterations: int = 30,
    ) -> np.ndarray:
        target = np.asarray(target, dtype=np.float64)
        for _ in range(max_iterations):
            action, center, error = self.action_toward(target)
            if np.linalg.norm(error) <= tolerance:
                return center
            self.sim.write_action(action, physics_steps=8)
        raise RuntimeError(f"Fingertip IK did not converge: target={target}, center={center}")

    def action_toward(
        self,
        target: np.ndarray,
        *,
        max_delta: float = 0.08,
        align_axis: bool = True,
        axis_target: np.ndarray | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Compute one bounded arm action toward a fingertip-center target."""
        target = np.asarray(target, dtype=np.float64)
        links = self.sim.read_links()
        self.jacobian.read(self.values)
        points = []
        point_jacobians = []
        for name, local_point in HULL_CENTROIDS.items():
            body = self.body_index[name]
            point, rotated = transform_point(links[body], local_point)
            row = body * 6
            linear = self.values[0, row : row + 3, 6:]
            angular = self.values[0, row + 3 : row + 6, 6:]
            points.append(point)
            point_jacobians.append(linear - cross_matrix(rotated) @ angular)
        center = np.mean(points, axis=0)
        error = target - center
        center_jacobian = np.mean(point_jacobians, axis=0)
        if align_axis:
            axis = points[0] - points[1]
            axis_jacobian = point_jacobians[0] - point_jacobians[1]
            desired_axis = np.zeros(3) if axis_target is None else np.asarray(axis_target)
            task_jacobian = np.vstack((center_jacobian, axis_jacobian[[0, 2]]))
            task_error = np.concatenate((error, desired_axis[[0, 2]] - axis[[0, 2]]))
        else:
            task_jacobian = center_jacobian
            task_error = error
        reduced = task_jacobian[:, self.arm_columns]
        delta = reduced.T @ np.linalg.solve(
            reduced @ reduced.T + 1e-3 * np.eye(len(task_error)), task_error
        )
        goal = self.sim.read_state()
        goal[self.arm_columns] += np.clip(delta, -max_delta, max_delta).astype(np.float32)
        return goal, center, error
