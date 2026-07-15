---
name: lerobot-serve
description: Serve LeRobot-compatible USD articulations through standalone NVIDIA ovphysx and ROS 2, control MOZ01's imported four-bar gripper, generate cube-pick demonstrations, and author USD-only collision overlays. Use when Codex needs to inspect or start a virtual robot bridge, replace proxy collision cubes, verify a MOZ01 pickup, or create camera-conditioned LeRobot pickup data. Before ROS work, verify the standalone ROS 2 root exists and ask the user to confirm its location when the default root is unavailable.
---

# LeRobot Serve

Use standalone `ovphysx`; never import `isaacsim`, `omni.*`, or start Kit. Keep generic ROS routing in the bridge and isolate MOZ01-specific pickup behavior under `scripts/moz01`.

## Prerequisites

- Before running the ROS bridge or any ROS command, verify that the default ROS 2 root `C:\Programs\ros2-windows` exists as a directory and contains `setup.bat`.
- If either check fails, stop and ask the user to confirm the standalone ROS 2 root. Resume only after validating the user-provided directory and its `setup.bat`; do not guess another location, install ROS, or mutate an existing ROS installation.
- This skill does not use Kit. Do not request or probe for a Kit root while performing `lerobot-serve` work.

## Start the bridge

1. Verify the USD path exists.
2. Inspect it with `uv run python scripts/serve.py --inspect <usd>`.
3. Confirm at least one articulation and review missing assets or closed-articulation diagnostics.
4. On Windows, run `scripts/run_ros.ps1 <usd>` with the validated ROS root and pass `-RosRoot` when it differs from `C:\Programs\ros2-windows`.
5. Verify `/lerobot/joint_states` before starting an independent recorder or renderer.

```powershell
uv sync
uv run python scripts/serve.py --inspect "C:\path\robot.usd"
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
uv run python scripts/patch_moz01_usd.py `
  "C:\path\moz_pick_cube_scene.usda" `
  "C:\path\moz_pick_cube_scene_collision.usda"
```

The overlay deactivates legacy cube proxies and authors two invisible eight-vertex convex fingertip meshes derived from the distal STL bounds. It also disables the two imported whole-link colliders that intersect neighboring right-hand linkage parts. The script refuses to overwrite its input or an existing output.

## MOZ01 pickup data

Verify the authored scene before recording:

```powershell
uv run python scripts/moz01/pickup_probe.py "C:\path\moz_pick_cube_scene_collision.usda"
```

Require `success=true`, finite state, pre-close cube translation below 5 mm, and minimum held lift of at least 5 cm.

Generate one or more complete expert episodes with `scripts/moz01/pickup_pipeline.py`. Use camera sensors when a renderer is running; the dataset exposes joint state, action, and images but not privileged cube pose.

```powershell
uv run python scripts/moz01/pickup_pipeline.py generate `
  --scene "C:\path\moz_pick_cube_scene_collision.usda" `
  --root "C:\datasets\moz01-pick" --repo-id "local/moz01-pick" `
  --episodes 1 --sensors front,closeup --width 320 --height 240
```

The dataset root must be new. Generate one evaluation episode per process because reused PhysX contact state is not independent.

## Separation of responsibilities

- Use `lerobot-record-simulation` for generic random-to-goal datasets.
- Use a renderer skill to publish camera images.
- Use a rollout skill to evaluate policies.
- Keep MOZ01 expert pickup control in `scripts/moz01`; do not place it in ignored `artifacts/` paths.

## Validate

Run `uv run pytest` after changing the generic bridge. Inspect a generated overlay before serving it and require one relative sublayer, two `fingertip_convex_hull` meshes, finite points, and inactive legacy cube proxies.
