---
name: lerobot-serve
description: Start a LeRobot-compatible virtual robot from a USD scene using standalone NVIDIA ovphysx, publish articulation state over ROS 2, accept commands, and run the bundled MOZ01 cube-pick generation and evaluation workflow. Use when Codex needs to serve, inspect, troubleshoot, generate demonstrations for, or evaluate a USD robot without Isaac Sim or Omniverse Kit.
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

## MOZ01 cube pickup

Keep MOZ01 control code under `scripts/moz01`; do not run control code from ignored `artifacts/` paths.

Use `scripts/moz01/control.py` as the single source of truth. It holds `RightArm_4` at -90 degrees and expands each finger crank into the imported open-chain equivalent: `joint2=-joint1`, `joint3=0`, and `loop=joint1`. Never add a physical closing joint to the ovphysx articulation.

Verify one deterministic pickup before generating data:

```powershell
uv run python scripts/moz01/pickup_probe.py "C:\path\moz_pick_cube_scene.usda"
```

Require `success=true`, finite state, pre-close cube translation below 5 mm, and minimum held lift of at least 5 cm.

Run the ROS bridge with the same command mapping:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_ros.ps1 `
  "C:\path\moz_pick_cube_scene.usda" -ControlProfile moz01
```

Generate and evaluate camera-conditioned LeRobot datasets with `scripts/moz01/pickup_pipeline.py`. Start the LeRobot renderer for the scene first and pass the configured sensor names to both generation and evaluation. The pipeline deliberately exposes robot joint state plus camera images, but not the cube's simulator pose, so the learned policy cannot bypass vision with privileged object coordinates. Run it from this skill's ovphysx environment while adding a Python 3.10 LeRobot environment to `PYTHONPATH`; the repository's `lerobot-record-simulation` environment is the standard choice. Always use new dataset roots and repository IDs.

```powershell
$env:PYTHONPATH="C:\repo\skills\lerobot-record-simulation\.venv\Lib\site-packages"
uv run python scripts/moz01/pickup_pipeline.py generate `
  --scene "C:\path\moz_pick_cube_scene.usda" `
  --root "C:\datasets\moz01-pick-v1" --repo-id "local/moz01-pick-v1" `
  --episodes 32 --sensors front,closeup --width 320 --height 240 --use-videos
```

Train with `lerobot-train` from the LeRobot environment. Confirm the training metadata contains `observation.images.*` features and does not contain `observation.environment_state`. On Windows, a completed checkpoint can still be followed by `WinError 1314` when LeRobot tries to create the `checkpoints/last` symlink; verify and use the explicit numbered `pretrained_model` directory.

Evaluate with the same sensor list and pipeline, and persist a rollout dataset using `--rollout-root` and `--rollout-repo-id`. Run exactly one evaluation episode per process, with a unique root, repository ID, and seed. A reused PhysX scene can retain contact state between episodes, so do not combine sequential episodes into an independent success rate. Treat metrics-only evaluation as incomplete.

Export an ovphysx trajectory using `pickup_probe.py --trajectory-out <file.npz>`, then render it with `render_trajectory.py <file.npz> <file.gif>` in an environment containing NumPy and Pillow.

## Diagnostics

- Treat missing referenced assets as a USD composition problem. Report exact unresolved paths; do not substitute Isaac assets.
- Treat an empty articulation binding as an incorrect prim pattern or a USD without `UsdPhysicsArticulationRootAPI`.
- Treat PhysX closed-articulation warnings as model-authoring issues. ovphysx may exclude loop joints; report the resulting `dof_names` from inspection.
- For MOZ01, use `--control-profile moz01` and the bundled open-chain coupling instead of authoring loop joints or PhysX mimic constraints.
- Use `--device cpu` when CUDA initialization fails. Use `--device gpu` only after CPU inspection succeeds.
- Stop cleanly with Ctrl+C so tensor bindings and the PhysX instance are released.
