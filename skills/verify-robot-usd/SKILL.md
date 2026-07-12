---
name: verify-robot-usd
description: Validate a robot USD with standalone NVIDIA ovphysx, detect missing articulations and invalid tensors, and stress simulation for NaN, Inf, excessive root drift, or unstable joint behavior. Use before recording or rollout, after changing robot physics, or when a USD robot falls away, explodes, or produces non-finite ROS state.
---

# Verify Robot USD

Use standalone `ovphysx`; never import `isaacsim`, `omni.*`, or start Kit.

## Run the gate

From this skill directory:

```powershell
uv sync
uv run python scripts/verify_robot_usd.py "C:\path\robot.usd"
```

The default gate runs 1,800 steps at 60 Hz, applies bounded sinusoidal position targets, and checks articulation position, velocity, effort, root pose/velocity, link pose/velocity, joint limits, masses, and inertias. It fails immediately on NaN or Inf and fails when a floating root drifts farther than 5 m.

Use `--lock-root` to reproduce a fixed-base recording setup without editing the USD:

```powershell
uv run python scripts/verify_robot_usd.py "C:\path\robot.usd" --lock-root
```

Run both modes for a floating-base asset: the authored run reveals unsupported free fall, while the locked run isolates joint and constraint stability. Pass the same root-lock mode to `lerobot-serve` during recording and rollout.

## Interpret results

- Treat missing USD, load failure, empty articulation binding, or invalid initial tensor as a hard failure.
- Treat `non_finite` as a hard numerical failure. Report its tensor, step, articulation row, and element index.
- Treat `root_drift` as a scene-support failure, not necessarily corrupt USD authoring. Add supporting collision geometry or intentionally use root locking.
- Treat a failed locked-root run as articulation, drive, constraint, mass, inertia, or collision instability. Do not record a dataset from that configuration.
- Review `native_diagnostics` for unresolved assets and closed-articulation bodies. `passed_with_warnings` means tensors stayed finite but authoring issues remain.
- Preserve the JSON output as verification evidence. A zero exit code means the requested configuration completed all steps with finite tensors; it does not erase reported authoring warnings.

Reduce `--amplitude` when authored joint limits are unusually narrow. Increase `--steps` for soak tests. Use `--no-stress` to distinguish passive-scene instability from drive instability.
