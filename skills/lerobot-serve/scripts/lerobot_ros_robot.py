"""LeRobot Robot adapter for the ROS topics published by serve.py."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

from lerobot.robots.config import RobotConfig
from lerobot.robots.robot import Robot


@RobotConfig.register_subclass("ovphysx_ros")
@dataclass
class OvPhysxRosRobotConfig(RobotConfig):
    namespace: str = "/lerobot"
    connect_timeout_s: float = 10.0


class OvPhysxRosRobot(Robot):
    config_class = OvPhysxRosRobotConfig
    name = "ovphysx_ros"

    def __init__(self, config: OvPhysxRosRobotConfig):
        super().__init__(config)
        self.config = config
        self.node = None
        self.publisher = None
        self._observation = None
        self._joint_names: list[str] = []

    @property
    def observation_features(self) -> dict:
        return {f"{name}.pos": float for name in self._joint_names}

    @property
    def action_features(self) -> dict:
        return {f"{name}.pos": float for name in self._joint_names}

    @property
    def is_connected(self) -> bool:
        return self.node is not None and self._observation is not None

    @property
    def is_calibrated(self) -> bool:
        return True

    def calibrate(self) -> None:
        return None

    def configure(self) -> None:
        return None

    def connect(self, calibrate: bool = True) -> None:
        if self.node is not None:
            return
        import rclpy
        from sensor_msgs.msg import JointState
        from std_msgs.msg import String

        if not rclpy.ok():
            rclpy.init()
        self.node = rclpy.create_node(f"lerobot_{self.id or 'ovphysx'}")
        ns = self.config.namespace.rstrip("/")

        def on_metadata(msg: String) -> None:
            self._joint_names = list(json.loads(msg.data)["dof_names"])

        def on_state(msg: JointState) -> None:
            self._joint_names = list(msg.name)
            self._observation = dict(zip(msg.name, msg.position, strict=False))

        self.node.create_subscription(String, f"{ns}/metadata", on_metadata, 10)
        self.node.create_subscription(JointState, f"{ns}/joint_states", on_state, 10)
        self.publisher = self.node.create_publisher(JointState, f"{ns}/command", 10)
        deadline = time.monotonic() + self.config.connect_timeout_s
        while self._observation is None and time.monotonic() < deadline:
            rclpy.spin_once(self.node, timeout_sec=0.1)
        if self._observation is None:
            self.disconnect()
            raise ConnectionError(f"No joint state received from {ns}/joint_states")

    def get_observation(self) -> dict[str, float]:
        if self.node is None:
            raise ConnectionError("Robot is not connected")
        import rclpy

        rclpy.spin_once(self.node, timeout_sec=0.0)
        return {f"{name}.pos": float(self._observation[name]) for name in self._joint_names}

    def send_action(self, action: dict[str, float]) -> dict[str, float]:
        if self.publisher is None:
            raise ConnectionError("Robot is not connected")
        from sensor_msgs.msg import JointState

        values = [float(action[f"{name}.pos"]) for name in self._joint_names]
        self.publisher.publish(JointState(name=self._joint_names, position=values))
        return {f"{name}.pos": value for name, value in zip(self._joint_names, values, strict=True)}

    def disconnect(self) -> None:
        if self.node is not None:
            self.node.destroy_node()
        self.node = None
        self.publisher = None
        self._observation = None
