---
name: lerobot-render
description: Render multiple USD camera sensors from ROS 2 TF poses with the omni.hydra.rtx Hydra renderer and publish each captured frame as its own sensor_msgs/Image topic. Use when Codex needs to visualize the virtual robot served by lerobot-serve, build multi-camera RTX ROS streams, or diagnose pose-to-render synchronization without launching Isaac Sim. Before rendering, verify the standalone ROS 2 and Kit roots exist and ask the user to confirm any location whose default root is unavailable.
---

# LeRobot Render

Use `omni.hydra.rtx` in Omniverse Kit; never import or launch Isaac Sim. Keep ROS and Kit in separate processes because their Python ABIs can differ.

## Windows shell safety

- Treat ROS names, USD prim paths, and Kit settings that begin with `/` or `--/` as semantic values, not filesystem paths.
- Run this skill's command blocks in PowerShell. Prefer `scripts\run_render.ps1` and omit slash-prefixed options when their defaults are sufficient so the launcher constructs and forwards those values outside Git Bash.
- Never pass slash-prefixed semantic values directly from Git Bash to a Windows-native executable because MSYS rewrites them as Windows paths; quoting does not prevent this conversion.
- If a direct Git Bash invocation is unavoidable, set `MSYS2_ARG_CONV_EXCL='*'` for that command only and pass actual filesystem paths in Windows form. Never change `/lerobot`, `/tf`, `/World/...`, or `--/exts/...` to work around shell conversion.

## Prerequisites

- Before any launch or ROS command, verify that `C:\isaacsim-6` and `C:\Programs\ros2-windows` each exist as directories. Also verify that the Kit root contains `kit\kit.exe` and the ROS 2 root contains `setup.bat`.
- If either default root or its required entry point is missing, stop and ask the user to confirm that root's actual location. Resume only after validating every user-provided directory and entry point; do not guess another location, install a runtime, or mutate an existing installation.
- Use the validated Kit runtime and extension folders. Reuse `kit\kit.exe` and `omni.hydra.rtx`; never launch `isaac-sim.bat` or an Isaac Sim app configuration.
- Use the validated standalone ROS 2 installation root and pass it through `-RosRoot` when it differs from the default.
- Reuse the ROS-compatible Python already present in the ROS tree, or select it through `-RosPython` or `ROS_PYTHON`. The supplied ROS tree currently keeps that runtime under `.pixi\envs\default`; never invoke Pixi, install an environment, or mutate the ROS installation.
- Auto-discover all cameras authored in the USD. Pass `-SensorsFile` to assign stable sensor names, or use `-Camera` for legacy single-camera operation. Create one transient fallback camera only when none exist.
- Bind every sensor to its own viewport for the lifetime of the renderer. Never multiplex cameras by changing one viewport's `camera_path` between captures because RTX viewport updates are asynchronous and can assign a previous camera's frame to the next sensor.
- Add neutral session-layer dome and key lights only when the USD contains no authored lights. Discard up to 30 all-black RTX warm-up captures, then fail instead of publishing unusable training data.

## Start rendering

Run from this skill directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_render.ps1 `
  -Usd "C:\path\scene.usd" `
  -SensorsFile "C:\path\sensors.json" `
  -RosPython "C:\path\python.exe"
```

Use a JSON object that maps sensor names to USD Camera prim paths:

```json
{
  "front": "/World/Robot/front_camera",
  "left_wrist": "/World/Robot/left_wrist_camera"
}
```

The launcher starts a hidden Kit process, then runs the ROS bridge in the supplied ROS Python. It shuts down only the Kit process it created when the ROS bridge exits.

## ROS contract

- Subscribe to `/tf` as `tf2_msgs/msg/TFMessage` by default.
- Interpret each transform as a world-space link pose published by `lerobot-serve`.
- Convert ROS TF translations from meters to the USD stage's authored `metersPerUnit` before applying poses.
- Publish `/lerobot/render/<sensor>/image_raw` as `sensor_msgs/msg/Image` for every configured or discovered sensor.
- Preserve the renderer buffer encoding (`rgb8` or `rgba8`), dimensions, row step, and capture timestamp.
- Override topics with `-TfTopic` and `-ImageTopicPrefix`.

The ROS bridge and renderer communicate only over loopback TCP. Do not expose the renderer port publicly. The renderer accepts multiple TCP clients and interleaved clients corrupt each other's frames: before recording, verify `netstat -ano | findstr 39080` shows exactly one established client, and kill orphaned `ros_image_bridge.py` processes from earlier sessions. Run the bridge and every TF publisher under a dedicated `ROS_DOMAIN_ID`; other `/tf` publishers with the same leaf frame names (such as the desktop app's own `serve.py`) silently overwrite poses and make objects flicker or freeze.

## Pose mapping

Resolve TF child-frame leaf names against USD prim names. Reject ambiguous names instead of moving the wrong prim. Author pose overrides into the stage session layer so the source USD is never modified. Convert world transforms to parent-local transforms before authoring nested links.

Preserve authored non-pose transforms when applying TF overrides, especially `xformOp:scale`. Never replace a scaled primitive with a rotation/translation-only matrix; doing so changes rendered geometry size even when physics remains correct. Only the posed prim's own scale is preserved: an `xformOp:scale` on an ancestor Xform is cancelled by the world-to-parent-local conversion, so scaled articulated assets must have the scale baked into their geometry (points, joint anchors, translate ops, mass by s^3) in a copied USD instead of an ancestor scale op. Visually inspect representative frames for semantic scale, framing, and object visibility instead of relying only on non-black pixel checks.

## Verification

Verify the input and output independently from PowerShell, not Git Bash:

```powershell
ros2 topic echo /tf --once
ros2 topic list | Select-String "/lerobot/render/.*/image_raw"
ros2 topic hz /lerobot/render/front/image_raw
ros2 topic info /lerobot/render/front/image_raw --verbose
```

Expect the first RTX launch to spend time compiling shaders. Treat a missing `kit.exe`, unavailable `omni.hydra.rtx`, explicitly invalid camera prim, or ambiguous link name as a hard startup error.
