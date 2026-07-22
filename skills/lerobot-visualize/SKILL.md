---
name: lerobot-visualize
description: Export USD collision geometry and display it in a local Three.js viewer driven in real time by ROS 2 TF poses from lerobot-serve. Use when Codex needs a lightweight collision-shape visualizer, needs to inspect physics poses without Kit or Isaac Sim, or needs to diagnose collision alignment in a LeRobot USD scene. Before ROS work, verify the standalone ROS 2 root exists and ask the user to confirm its location when the default root is unavailable.
---

# LeRobot Visualize

Render only physics collision shapes in a browser. Keep the viewer local: the ROS bridge binds to loopback by default and does not modify the source USD.

## Windows launcher rule

- Start every LeRobot workflow through a supplied `.ps1` launcher. Invoke that launcher from PowerShell; do not invoke the underlying Python, ROS 2, Kit, or UV entry point directly from Git Bash.
- Define every semantic argument beginning with `/` or `--/` inside the `.ps1` file. This includes `/tf`, `/clock`, `/lerobot/...`, `/World/...`, and Kit `--/exts/...` settings. Do not expose these values as Git Bash command-line arguments.
- Treat Windows filesystem paths as launcher parameters. Quoting does not stop MSYS path expansion, so never rely on quoting or `MSYS2_ARG_CONV_EXCL` as a workaround.
- When a required launcher does not exist, add or update a `.ps1` launcher instead of documenting a direct command.

## Prerequisites

- Verify the USD scene exists.
- Before running ROS commands on Windows, verify `C:\Programs\ros2-windows` exists and contains `setup.bat`. If not, stop and ask the user for the standalone ROS 2 root; do not guess or install ROS.
- Run `uv sync` in this skill directory to install the isolated USD exporter. Run the live bridge with the standalone ROS 2 Python interpreter that imports `rclpy`; the exporter and bridge do not need the same interpreter.
- Run `pnpm install` and `pnpm build` in this skill directory only when changing the browser source. The committed bundle is ready to serve.

## Export collision geometry

Export active USD prims with `PhysicsCollisionAPI`. The exporter converts stage units to meters, triangulates mesh faces, and stores every shape relative to its nearest rigid body so incoming world poses can drive it.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_visualize.ps1 `
  -Export -Usd "C:\path\robot.usd" -Output "C:\path\robot.collision.json"
```

Re-export after changing collision geometry, articulation roots, rigid-body names, or stage units. Do not use render meshes as collision substitutes.

## Start the live viewer

Start `lerobot-serve` first, then run the viewer in a shell with the same `ROS_DOMAIN_ID`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_visualize.ps1 `
  -Collision "C:\path\robot.collision.json"
```

Open `http://127.0.0.1:8765`. The launcher owns the `/tf` topic string. Use `-Port` to avoid a local conflict. Keep the default loopback host unless the user explicitly requests network access; update the launcher rather than passing a slash-prefixed topic at the shell.

## Pose contract

- Consume `tf2_msgs/msg/TFMessage` from `/tf`.
- Interpret translations as meters and quaternions as ROS `(x, y, z, w)` world poses.
- Match each TF child frame exactly to `<articulation-root>/<body-name>`, using the same sanitization as `lerobot-serve`.
- Leave static collision geometry at its authored world transform.
- Ignore TF frames that have no exported collision shape; never guess a fuzzy match.

When geometry is offset, use the viewer link count and `lerobot-render`'s `scripts/check_render.ps1` launcher to inspect `/tf`, then compare the exported frame names. Re-export after correcting USD rigid-body ownership rather than adding viewer-specific offsets.

## Validate

Run the skill validator and Python syntax checks. Build the browser bundle after editing `assets/src/app.js`, then confirm that the viewer reports a live connection and moving collision links while `lerobot-serve` is publishing `/tf`.
