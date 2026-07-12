---
name: lerobot-rollout-simulation
description: Evaluate a trained LeRobot policy on an ovphysx virtual robot over ROS 2, run autonomous randomized simulation rollouts, compute goal and timing metrics, and save joint state, actions, and multiple rendered sensors as a local LeRobot dataset for human review. Use when Codex needs to deploy a local or Hugging Face LeRobot checkpoint in the virtual robot, compare checkpoints, inspect failures, or produce repeatable simulation evaluation evidence without Isaac Sim.
---

# LeRobot Rollout Simulation

Run a pretrained LeRobot policy against the ROS contract from `lerobot-serve` and optionally `lerobot-render`. Keep evaluation independent of project-specific code and LeRobot built-in Gym environments.

## Prepare

1. Run `uv sync` in this skill directory.
2. Start `lerobot-serve` with the evaluation USD.
3. Start `lerobot-render` when the checkpoint uses images. Match sensor names and resolutions to the training dataset.
4. Verify the checkpoint directory contains `config.json`, `model.safetensors`, and its saved processor configs. A Hugging Face model ID is also accepted.

The launcher sources `C:\Programs\ros2-windows\setup.bat` and reuses its existing runtime DLLs. Never invoke Pixi or modify the ROS installation. The bundled UV environment is CPU-oriented; pass `-Python` with a compatible LeRobot/CUDA environment for GPU or model-specific extras.

## Run evaluation

```powershell
uv sync
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\run_rollout.ps1 `
  -Model "C:\models\random-to-goal\pretrained_model" `
  -DatasetRoot "C:\datasets\eval-random-to-goal" `
  -RepoId "local/eval-random-to-goal" `
  -Episodes 20 `
  -Sensors "front,left_wrist" `
  -Task "Move to the fixed target pose" `
  -Goal '{"joint_1":0.0,"joint_2":-0.5}'
```

Omit `-Goal` for an all-zero fixed target. Each episode resets to a different pose sampled within `RandomRadius` of that target, then lets the model control the robot for `Duration` seconds. Use `-Sensors auto` to discover all render topics or `-Sensors none` for state-only checkpoints.

Never overwrite an existing dataset root. Keep results local unless the user explicitly requests a Hub upload.

## Default persistence contract

- Always save rollout trajectories as a finalized local LeRobot dataset by default, including task-specific evaluations and custom evaluation adapters.
- Require a new dataset root and repository ID for every evaluation run. Do not implement or select a metrics-only path merely because the policy is state-only or the task uses custom success metrics.
- Skip rollout-dataset persistence only when the user explicitly requests no saved rollout data. A request to test, evaluate, or report success rate does not opt out.
- Treat an evaluation that produced only logs or `evaluation.json` as incomplete. Recover by rerunning or converting captured trajectories; never claim that an evaluation dataset was saved.
- Finalize and reopen the dataset before reporting evaluation completion or launching `lerobot-dataset-viz`.

## Outputs

- Save every rollout as a LeRobot episode with `observation.state`, `action`, task-specific environment observations, and each `observation.images.<sensor>`.
- Write `evaluation.json` beside the dataset metadata with per-episode reset error, final/minimum goal error, success, inference latency, control overruns, and aggregate success rate.
- Call `save_episode()` after every rollout and `finalize()` before reopening the dataset.
- Define success as final maximum absolute joint error not exceeding `SuccessTolerance`. Treat this as a generic automatic signal; use the saved images for task-level human judgment.

Review an episode locally:

```powershell
uv run lerobot-dataset-viz --repo-id "local/eval-random-to-goal" `
  --root "C:\datasets\eval-random-to-goal" --mode local --episode-index 0
```

## Guardrails

- Require checkpoint observation and action features to match current joint names, sensor names, and image shapes.
- Reset the policy and its processors between episodes so temporal action queues do not leak across rollouts.
- Record the exact action returned by the postprocessor and sent to ROS.
- Fail on stale sensor data, changing joint order, non-finite actions, action-size mismatch, missing processor files, or failure to reopen the finalized dataset.
- Reduce `RandomRadius` when reset targets exceed authored joint limits. Use `-StopOnSuccess` only when variable-length evaluation episodes are acceptable.
