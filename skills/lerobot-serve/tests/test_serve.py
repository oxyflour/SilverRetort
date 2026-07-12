from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from ovphysx import TensorType


SCRIPT = Path(__file__).parents[1] / "scripts" / "serve.py"
SPEC = importlib.util.spec_from_file_location("lerobot_serve_script", SCRIPT)
assert SPEC and SPEC.loader
serve = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(serve)


DOF_TYPES = {
    TensorType.ARTICULATION_DOF_POSITION,
    TensorType.ARTICULATION_DOF_VELOCITY,
    TensorType.ARTICULATION_DOF_POSITION_TARGET,
    TensorType.ARTICULATION_DOF_VELOCITY_TARGET,
    TensorType.ARTICULATION_DOF_ACTUATION_FORCE,
}


class FakeBinding:
    def __init__(self, tensor_type: TensorType):
        self.tensor_type = tensor_type
        self.prim_paths = ["/World/A/root", "/World/B/root"]
        self.dof_names = ["shoulder", "wrist"]
        self.body_names = ["base", "tool", "finger"]
        self.is_fixed_base = False
        if tensor_type in DOF_TYPES:
            self.shape = (2, 2)
        elif tensor_type == TensorType.ARTICULATION_ROOT_POSE:
            self.shape = (2, 7)
        elif tensor_type == TensorType.ARTICULATION_LINK_POSE:
            self.shape = (2, 3, 7)
        else:  # pragma: no cover - test fixture guards production binding additions
            raise AssertionError(f"Unexpected tensor type: {tensor_type}")
        self.values = np.zeros(self.shape, dtype=np.float32)
        self.writes: list[np.ndarray] = []
        self.destroyed = False

    def read(self, output: np.ndarray) -> None:
        np.copyto(output, self.values)

    def write(self, value: np.ndarray) -> None:
        self.values = value.copy()
        self.writes.append(value.copy())

    def destroy(self) -> None:
        self.destroyed = True


class FakePhysX:
    instances: list["FakePhysX"] = []

    def __init__(self, *, device: str):
        self.device = device
        self.bindings: dict[TensorType, FakeBinding] = {}
        self.steps: list[tuple[float, float]] = []
        self.released = False
        self.__class__.instances.append(self)

    def add_usd(self, path: str) -> tuple[int, int]:
        self.usd_path = path
        return 1, 7

    def wait_op(self, op: int) -> None:
        self.waited_for = op

    def step_sync(self, dt: float, sim_time: float) -> None:
        self.steps.append((dt, sim_time))

    def create_tensor_binding(
        self, pattern: str, *, tensor_type: TensorType, raise_if_empty: bool
    ) -> FakeBinding:
        assert pattern == "/World/**"
        assert raise_if_empty is True
        binding = FakeBinding(tensor_type)
        self.bindings[tensor_type] = binding
        return binding

    def release(self) -> None:
        self.released = True


@pytest.fixture
def simulation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(serve, "PhysX", FakePhysX)
    usd = tmp_path / "robot.usd"
    usd.write_text("#usda 1.0", encoding="utf-8")
    args = SimpleNamespace(
        usd=usd,
        articulation="/World/**",
        fps=50.0,
        device="cpu",
    )
    sim = serve.Simulation(args)
    yield sim
    sim.close()


def test_frame_name_sanitizes_usd_paths() -> None:
    assert serve.frame_name("/World/My Robot::tool-1") == "World/My_Robot/tool_1"
    assert serve.frame_name("///") == "robot"


def test_simulation_reports_articulation_metadata(simulation) -> None:
    metadata = simulation.metadata()

    assert metadata["articulation_roots"] == ["/World/A/root", "/World/B/root"]
    assert metadata["dof_names"] == ["shoulder", "wrist"]
    assert metadata["body_names"] == ["base", "tool", "finger"]
    assert metadata["fps"] == 50.0
    assert simulation.physx.waited_for == 7


def test_command_routes_prefixed_joint_values_to_each_control(simulation) -> None:
    names = ["/World/A/root::shoulder", "/World/B/root::wrist", "unknown"]
    simulation.command(
        names,
        position=[1.0, 2.0, 99.0],
        velocity=[3.0, 4.0, 99.0],
        effort=[5.0, 6.0, 99.0],
    )

    position = simulation.physx.bindings[TensorType.ARTICULATION_DOF_POSITION_TARGET]
    velocity = simulation.physx.bindings[TensorType.ARTICULATION_DOF_VELOCITY_TARGET]
    effort = simulation.physx.bindings[TensorType.ARTICULATION_DOF_ACTUATION_FORCE]
    assert position.writes[-1].tolist() == [[1.0, 0.0], [0.0, 2.0]]
    assert velocity.writes[-1].tolist() == [[3.0, 0.0], [0.0, 4.0]]
    assert effort.writes[-1].tolist() == [[5.0, 0.0], [0.0, 6.0]]


def test_step_and_close_release_native_resources(simulation) -> None:
    simulation.step()
    physx = simulation.physx

    assert physx.steps[-1] == pytest.approx((0.02, 0.02))
    simulation.close()
    assert physx.released is True
    assert all(binding.destroyed for binding in physx.bindings.values())
    simulation.bindings.clear()  # keep fixture teardown idempotent
