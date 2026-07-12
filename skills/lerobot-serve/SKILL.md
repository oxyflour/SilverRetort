---
name: lerobot-serve
description: Start a LeRobot-compatible virtual robot from a USD scene using the standalone NVIDIA ovphysx package, publish articulation joint state and link poses over ROS 2, and accept ROS joint commands. Use when Codex needs to serve, inspect, or troubleshoot a USD robot for LeRobot/ROS without Isaac Sim or Omniverse Kit.
---

# LeRobot Serve

Use standalone `ovphysx`; never import `isaacsim`, `omni.*`, or start Kit.

## Start the robot

1. Verify the USD path exists.
2. Run `scripts/serve.py --inspect <usd>` through UV. Confirm at least one articulation and review missing asset or closed-articulation diagnostics.
3. On Windows, run `scripts/run_ros.ps1 <usd>` to activate `C:\Programs\ros2-windows` and start the ROS node. Override `-RosRoot` only when the user supplies a different standalone ROS installation.
4. Keep the process attached unless the user explicitly requests background execution. Report its PID and ROS topics when backgrounding it.
5. Verify `/lerobot/joint_states` receives messages before declaring success.

Typical Windows commands from this skill directory:

```powershell
uv sync
uv run python scripts/serve.py --inspect "C:\path\robot.usd"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_ros.ps1 "C:\path\robot.usd"
ros2 topic echo /lerobot/joint_states --once
```

Use the bundled `pyproject.toml` and `uv.lock` for inspection and tests. Keep its Python version on 3.10 so binary `rclpy` modules from `C:\Programs\ros2-windows` remain ABI-compatible. Let `run_ros.ps1` reuse the Python already supplied with that ROS tree, install ovphysx into the skill-local `.ros-overlay`, and obtain ROS environment variables through `setup.bat`. The supplied ROS tree currently stores its existing Python under `.pixi\envs\default`, but the launcher never invokes Pixi, installs a Pixi environment, or mutates the ROS installation. Pass `-RosPython` or set `ROS_PYTHON` for a differently packaged ROS tree.

Pass `-LockRoot` for a floating-base articulation in a scene without supporting geometry. This holds each root at its initial world pose while leaving articulation joints dynamic, preventing the robot from falling out of rendered camera views during dataset recording and rollout.

Check the combined ROS and ovphysx environment without starting simulation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_ros.ps1 "C:\path\robot.usd" -CheckOnly
```

Run unit tests after changing the bridge:

```powershell
uv run pytest
```

## Interface

The server automatically binds all articulations below `/World/**`. Override this with `--articulation <prim-pattern>` when necessary.

- Publish `/lerobot/joint_states` as `sensor_msgs/msg/JointState`.
- Publish `/lerobot/root_pose` as `geometry_msgs/msg/PoseStamped` for the first articulation root.
- Publish `/tf` as `tf2_msgs/msg/TFMessage` for every articulation link in world coordinates.
- Publish transient-local `/lerobot/metadata` as JSON in `std_msgs/msg/String`.
- Publish `/clock` as `rosgraph_msgs/msg/Clock` unless `--no-clock` is set.
- Subscribe to `/lerobot/command` as `sensor_msgs/msg/JointState`. Map `position`, `velocity`, and `effort` to ovphysx position targets, velocity targets, and actuation force respectively.

With multiple articulations, names use `<root>::<joint>` and TF child frames use `<root>/<link>` to remain unique. With one articulation, joint names remain the USD DOF names.

## LeRobot integration

Use `scripts/lerobot_ros_robot.py` as the `Robot` adapter in a LeRobot process. Import the module before constructing `OvPhysxRosRobotConfig`; then call `connect()`, `get_observation()`, and `send_action()` normally. The adapter discovers joint names from `/lerobot/metadata` during `connect()`.

For LeRobot CLI registration, vendor the adapter into the user's Python package and ensure it is imported before `make_robot_from_config()` runs. Do not modify an installed LeRobot package without explicit user approval.

## Diagnostics

- Treat missing referenced assets as a USD composition problem. Report exact unresolved paths; do not substitute Isaac assets.
- Treat an empty articulation binding as an incorrect prim pattern or a USD without `UsdPhysicsArticulationRootAPI`.
- Treat PhysX closed-articulation warnings as model-authoring issues. ovphysx may exclude loop joints; report the resulting `dof_names` from inspection.
- Use `--device cpu` when CUDA initialization fails. Use `--device gpu` only after CPU inspection succeeds.
- Stop cleanly with Ctrl+C so tensor bindings and the PhysX instance are released.
