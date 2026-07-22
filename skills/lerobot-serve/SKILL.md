---
name: lerobot-serve
description: Serve LeRobot-compatible USD articulations through standalone NVIDIA ovphysx and ROS 2, control MOZ01's imported four-bar gripper, generate cube-pick demonstrations, and author USD-only collision overlays. Use when Codex needs to inspect or start a virtual robot bridge, replace proxy collision cubes, verify a MOZ01 pickup, or create camera-conditioned LeRobot pickup data. Before ROS work, verify the standalone ROS 2 root exists and ask the user to confirm its location when the default root is unavailable.
---

# LeRobot Serve

Use standalone `ovphysx`; never import `isaacsim`, `omni.*`, or start Kit. Keep generic ROS routing in the bridge and isolate MOZ01-specific pickup behavior under `scripts/moz01`.

## Windows launcher rule

- Start every LeRobot workflow through a supplied `.ps1` launcher. Invoke that launcher from PowerShell; do not invoke the underlying Python, ROS 2, Kit, or UV entry point directly from Git Bash.
- Define every semantic argument beginning with `/` or `--/` inside the `.ps1` file. This includes `/tf`, `/clock`, `/lerobot/...`, `/World/...`, and Kit `--/exts/...` settings. Do not expose these values as Git Bash command-line arguments.
- Treat Windows filesystem paths as launcher parameters. Quoting does not stop MSYS path expansion, so never rely on quoting or `MSYS2_ARG_CONV_EXCL` as a workaround.
- When a required launcher does not exist, add or update a `.ps1` launcher instead of documenting a direct command.

## Prerequisites

- Before running the ROS bridge or any ROS command, verify that the default ROS 2 root `C:\Programs\ros2-windows` exists as a directory and contains `setup.bat`.
- If either check fails, stop and ask the user to confirm the standalone ROS 2 root. Resume only after validating the user-provided directory and its `setup.bat`; do not guess another location, install ROS, or mutate an existing ROS installation.
- This skill does not use Kit. Do not request or probe for a Kit root while performing `lerobot-serve` work.

## Start the bridge

1. Verify the USD path exists.
2. Inspect it through `scripts/run_ros.ps1 -Inspect`; never invoke `serve.py` directly.
3. Confirm at least one articulation and review missing assets or closed-articulation diagnostics.
4. On Windows, run `scripts/run_ros.ps1 <usd>` with the validated ROS root and pass `-RosRoot` when it differs from `C:\Programs\ros2-windows`.
5. Verify `/lerobot/joint_states` before starting an independent recorder or renderer.

Run `uv sync` once when provisioning the skill, then use the launcher for both inspection and serving:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_ros.ps1 `
  "C:\path\robot.usd" -Inspect
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_ros.ps1 `
  "C:\path\robot.usd" -LockRoot
```

Keep the process attached unless the user requests background execution. Use `-LockRoot` for floating articulations that must remain at their authored world pose.

## ROS interface

- Publish `/lerobot/joint_states`, `/lerobot/root_pose`, `/tf`, `/lerobot/metadata`, and `/clock`.
- Subscribe to `/lerobot/command` as `sensor_msgs/msg/JointState`.
- Map named position, velocity, and effort values directly to ovphysx targets.
- Prefix names with `<root>::` only when a scene contains multiple articulations.

Use `scripts/lerobot_ros_robot.py` as the generic LeRobot `Robot` adapter. Keep robot-specific coupling in the commanding client or authored USD, not in this bridge.

For MOZ01, pass `-ControlProfile moz01`. This expands each commanded finger crank into the imported open-chain equivalent using `scripts/moz01/control.py`: `joint2=-joint1`, `joint3=0`, and `loop=joint1`.

## Author the MOZ01 collision overlay

Create a new layer without modifying the source:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_moz01.ps1 `
  -Action PatchCollision -Scene "C:\path\moz_pick_cube_scene.usda" `
  -Output "C:\path\moz_pick_cube_scene_collision.usda"
```

The overlay deactivates legacy cube proxies and authors two invisible eight-vertex convex fingertip meshes derived from the distal STL bounds. It also disables the two imported whole-link colliders that intersect neighboring right-hand linkage parts. The script refuses to overwrite its input or an existing output.

## MOZ01 pickup data

Verify the authored scene before recording:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_moz01.ps1 `
  -Action PickupProbe -Scene "C:\path\moz_pick_cube_scene_collision.usda"
```

Require `success=true`, finite state, pre-close cube translation below 5 mm, and minimum held lift of at least 5 cm.

Generate one or more complete expert episodes with `scripts/moz01/pickup_pipeline.py`. Use camera sensors when a renderer is running; the dataset exposes joint state, action, and images but not privileged cube pose.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_moz01.ps1 `
  -Action PickupGenerate -Scene "C:\path\moz_pick_cube_scene_collision.usda" `
  -DatasetRoot "C:\datasets\moz01-pick" -RepoId "local/moz01-pick" `
  -Episodes 1 -Sensors "front,closeup" -Width 320 -Height 240
```

The dataset root must be new. Generate one evaluation episode per process because reused PhysX contact state is not independent.

## MOZ01 knob-turn data (gas stove)

Scene: `artifacts/moz01/USD/moz_gas_stove_scene.usda`. It references
`gas_stove/gas_stove_knob_articulated_380.usd`, which has the real 380 mm
stove length baked into the geometry. Never re-add an `xformOp:scale` above an
articulated asset: lerobot-render TF pose overrides drop ancestor scale and
render the object at full size while physics stays scaled. Bake scale into a
copy of the asset instead (points, joint localPos, translate, mass x s^3).

The gripper opens only 2.4 cm and the knob head is 3.8 cm, so the expert
friction-dials: closed fingertips press ~3 mm into the knob face at 1.2 cm
radius and drag a 60 deg arc; the knob drive is authored as dry friction
(stiffness 0) so it holds its final angle. Success requires at least 0.8 rad
held over the last 10 frames. Deeper presses wedge on the rotating head and
destabilize the arm.

Record an episode (renderer must already be running, see below):

```powershell
$env:ROS_DOMAIN_ID = "42"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\moz01\run_turn_knob.ps1 `
  -Scene "C:\Projects\SilverRetort\artifacts\moz01\USD\moz_gas_stove_scene.usda" `
  -DatasetRoot "C:\path\to\new-dataset-root" `
  -RepoId "local/moz01-knob-turn" -Episodes 1
```

`run_turn_knob.ps1` assembles the environment (lerobot-record-simulation venv
for lerobot/torch, ROS `setup.bat` for rclpy, this skill's `.ros-overlay` for
ovphysx) and runs `scripts/moz01/turn_knob_pipeline.py`. The dataset root must
be new.

Recording environment rules (violations corrupt images silently while physics
metrics stay perfect):

1. Start `lerobot-render` first with the same scene, a sensors file such as
   `artifacts/moz01/USD/knob_sensors.json`, and the same `ROS_DOMAIN_ID`.
2. Always isolate with a dedicated `ROS_DOMAIN_ID` (e.g. 42): the desktop app
   runs its own `serve.py` publishing `/tf` with identical frame names on
   domain 0, and stale poses make the robot flicker or freeze in the render.
3. Before recording, verify `netstat -ano | findstr 39080` shows exactly one
   established client pair. Orphaned `ros_image_bridge.py` processes survive
   for days and reconnect to new renderers; kill them.
4. The pipeline refuses to finalize when rendered images are static (TF never
   reached the renderer). Expect ~2% of frames with front/closeup images
   swapped from an upstream RTX cross-viewport race; treat more as a failure.

## Separation of responsibilities

- Use `lerobot-record-simulation` for generic random-to-goal datasets.
- Use a renderer skill to publish camera images.
- Use a rollout skill to evaluate policies.
- Keep MOZ01 expert control in `scripts/moz01` (`pickup_pipeline.py`,
  `turn_knob_pipeline.py` with launchers `run_ros.ps1`/`run_turn_knob.ps1`);
  do not place it in ignored `artifacts/` paths.

## Validate

Run `scripts/check_serve.ps1` from PowerShell after changing the generic bridge; the launcher owns the underlying UV/pytest invocation. Inspect a generated overlay before serving it and require one relative sublayer, two `fingertip_convex_hull` meshes, finite points, and inactive legacy cube proxies.
