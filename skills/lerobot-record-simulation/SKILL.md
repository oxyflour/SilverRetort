---
name: lerobot-record-simulation
description: Record local LeRobot datasets from an ovphysx virtual robot over ROS 2, including joint state, commanded action, and any number of rendered camera sensors. Use when Codex needs to collect simulation demonstrations, validate the LeRobot dataset recording pipeline, or generate a randomized-start-to-fixed-goal dataset without Isaac Sim.
---

# LeRobot Record Simulation

Record demonstrations from the ROS contract exposed by `lerobot-serve` and optionally `lerobot-render`. Keep the recorder independent of any project-specific package.

## Windows shell safety

- Treat ROS names, USD prim paths, and Kit settings that begin with `/` or `--/` as semantic values, not filesystem paths.
- Run this skill's command blocks in PowerShell. Prefer the supplied `.ps1` launchers and omit slash-prefixed options when their defaults are sufficient so the launcher constructs and forwards those values outside Git Bash.
- Never pass slash-prefixed semantic values directly from Git Bash to a Windows-native executable because MSYS rewrites them as Windows paths; quoting does not prevent this conversion.
- If a direct Git Bash invocation is unavoidable, set `MSYS2_ARG_CONV_EXCL='*'` for that command only and pass actual filesystem paths in Windows form. Never change `/lerobot`, `/tf`, `/World/...`, or `--/exts/...` to work around shell conversion.

## Prepare

1. Run `uv sync` in this skill directory. Use Python 3.10 because `C:\Programs\ros2-windows` provides CPython 3.10 `rclpy` binaries.
2. Start `lerobot-serve` with the target USD.
3. Start `lerobot-render` when images are required. Its sensor topics must follow `/lerobot/render/<sensor>/image_raw`.
4. Check `/lerobot/joint_states` and each requested image topic before recording.

The launcher sources `C:\Programs\ros2-windows\setup.bat` and reuses its existing runtime DLLs. Never invoke Pixi, install a Pixi environment, or modify the ROS installation.

## Record the demo

Run from this skill directory:

```powershell
uv sync
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_record.ps1 `
  -DatasetRoot "C:\datasets\random-to-goal" `
  -RepoId "local/random-to-goal" `
  -Episodes 20 `
  -Sensors "front,left_wrist" `
  -Goal '{"joint_1":0.0,"joint_2":-0.5}'
```

Omit `-Goal` to use an all-zero fixed target. Each episode samples a different initial pose uniformly within `RandomRadius` of that same goal, settles there without recording, then records a smooth joint-space trajectory to the goal.

Use `-Sensors auto` to discover all `/lerobot/render/*/image_raw` topics, or `-Sensors none` for a proprioception-only dataset. Every selected sensor becomes `observation.images.<sensor>`.

The dataset root must not exist. Never delete or overwrite an existing dataset automatically. Default to image files for the most robust Windows workflow; pass `-UseVideos` only when the local LeRobot video encoder is known to work.

## Dataset contract

- Store current joint positions in `observation.state` using ROS joint-name order.
- Store the commanded target for that frame in `action` using the same order.
- Store RGB `uint8` arrays as `observation.images.<sensor>` for every sensor.
- Attach the task `Move from a random initial joint pose to the fixed target pose` to every frame.
- Call `save_episode()` after each demonstration and `finalize()` before reopening the dataset.
- Keep output local. Upload to the Hugging Face Hub only after the user explicitly requests it.

## Verify

The recorder reopens the finalized dataset and prints a JSON summary. Also inspect it with:

```powershell
uv run lerobot-info
uv run lerobot-dataset-viz --repo-id "local/random-to-goal" --root "C:\datasets\random-to-goal" --mode local --episode-index 0
```

Treat missing joint metadata, inconsistent joint order, stale sensor frames, an existing output root, or failure to reopen the finalized dataset as hard errors. A reset pose outside the robot's authored limits may fail to settle; reduce `-RandomRadius` or provide a safer fixed goal.
