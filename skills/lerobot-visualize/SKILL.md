---
name: lerobot-visualize
description: Export USD collision geometry and display it in a local Three.js viewer driven in real time by ROS 2 TF poses from lerobot-serve. Use when Codex needs a lightweight collision-shape visualizer, needs to inspect physics poses without Kit or Isaac Sim, or needs to diagnose collision alignment in a LeRobot USD scene. Before ROS work, verify the standalone ROS 2 root exists and ask the user to confirm its location when the default root is unavailable.
---

# LeRobot Visualize

Render only physics collision shapes in a browser. Keep the viewer local: the ROS bridge binds to loopback by default and does not modify the source USD.

## Prerequisites

- Verify the USD scene exists.
- Before running ROS commands on Windows, verify `C:\Programs\ros2-windows` exists and contains `setup.bat`. If not, stop and ask the user for the standalone ROS 2 root; do not guess or install ROS.
- Run `uv sync` in this skill directory to install the isolated USD exporter. Run the live bridge with the standalone ROS 2 Python interpreter that imports `rclpy`; the exporter and bridge do not need the same interpreter.
- Run `pnpm install` and `pnpm build` in this skill directory only when changing the browser source. The committed bundle is ready to serve.

## Export collision geometry

Export active USD prims with `PhysicsCollisionAPI`. The exporter converts stage units to meters, triangulates mesh faces, and stores every shape relative to its nearest rigid body so incoming world poses can drive it.

```powershell
uv run python scripts\export_collision.py `
  "C:\path\robot.usd" "C:\path\robot.collision.json"
```

Re-export after changing collision geometry, articulation roots, rigid-body names, or stage units. Do not use render meshes as collision substitutes.

## Start the live viewer

Start `lerobot-serve` first, then run the viewer in a shell with the same `ROS_DOMAIN_ID`:

```powershell
python scripts\serve_visualizer.py "C:\path\robot.collision.json"
```

Open `http://127.0.0.1:8765`. Override `--tf-topic` only when the serving bridge publishes poses somewhere other than `/tf`. Use `--port` to avoid a local conflict. Do not expose `--host 0.0.0.0` unless the user explicitly requests network access.

## Pose contract

- Consume `tf2_msgs/msg/TFMessage` from `/tf`.
- Interpret translations as meters and quaternions as ROS `(x, y, z, w)` world poses.
- Match each TF child frame exactly to `<articulation-root>/<body-name>`, using the same sanitization as `lerobot-serve`.
- Leave static collision geometry at its authored world transform.
- Ignore TF frames that have no exported collision shape; never guess a fuzzy match.

When geometry is offset, compare the exported frame names with `ros2 topic echo /tf --once`. Re-export after correcting USD rigid-body ownership rather than adding viewer-specific offsets.

## Validate

Run the skill validator and Python syntax checks. Build the browser bundle after editing `assets/src/app.js`, then confirm that the viewer reports a live connection and moving collision links while `lerobot-serve` is publishing `/tf`.
