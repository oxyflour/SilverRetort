#!/usr/bin/env python3
"""Evaluate a pretrained LeRobot policy against the ROS ovphysx simulation."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from ros_simulation import RosSimulation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="local pretrained_model directory or Hugging Face ID")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--repo-id", default="local/eval-simulation")
    parser.add_argument("--episodes", type=int, default=10)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--duration", type=float, default=10.0)
    parser.add_argument("--reset-time", type=float, default=2.0)
    parser.add_argument("--random-radius", type=float, default=0.25)
    parser.add_argument("--goal", default="", help="JSON joint map or ordered array; empty means all zeros")
    parser.add_argument("--success-tolerance", type=float, default=0.05)
    parser.add_argument("--task", default="Move to the fixed target pose")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--namespace", default="/lerobot")
    parser.add_argument("--image-topic-prefix", default="/lerobot/render")
    parser.add_argument("--sensors", default="auto", help="comma-separated names, auto, or none")
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--frame-timeout", type=float, default=5.0)
    parser.add_argument("--stop-on-success", action="store_true")
    parser.add_argument("--use-videos", action="store_true")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.root.exists():
        raise SystemExit(f"Dataset root already exists; refusing to overwrite: {args.root}")
    for name in ("episodes", "fps"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name} must be positive")
    for name in ("duration", "reset_time", "startup_timeout", "frame_timeout", "success_tolerance"):
        if getattr(args, name) <= 0:
            raise SystemExit(f"--{name.replace('_', '-')} must be positive")
    if args.random_radius < 0:
        raise SystemExit("--random-radius must be non-negative")


def resolve_goal(raw: str, names: list[str]) -> np.ndarray:
    if not raw:
        return np.zeros(len(names), dtype=np.float32)
    value = json.loads(raw)
    if isinstance(value, dict):
        unknown = sorted(set(value) - set(names))
        if unknown:
            raise ValueError(f"Goal contains unknown joints: {unknown}")
        return np.asarray([value.get(name, 0.0) for name in names], dtype=np.float32)
    result = np.asarray(value, dtype=np.float32)
    if result.shape != (len(names),):
        raise ValueError(f"Goal array must contain {len(names)} values")
    return result


def make_features(simulation: RosSimulation, use_videos: bool) -> dict:
    count = len(simulation.joint_names)
    features = {
        "observation.state": {"dtype": "float32", "shape": (count,), "names": simulation.joint_names},
        "action": {"dtype": "float32", "shape": (count,), "names": simulation.joint_names},
    }
    for sensor in simulation.sensor_names:
        features[f"observation.images.{sensor}"] = {
            "dtype": "video" if use_videos else "image",
            "shape": simulation.images[sensor].shape,
            "names": ["height", "width", "channels"],
        }
    return features


def load_policy(model: str, device: str, dataset):
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies.factory import make_policy, make_pre_post_processors
    from lerobot.utils.import_utils import register_third_party_plugins

    register_third_party_plugins()
    config = PreTrainedConfig.from_pretrained(model)
    config.pretrained_path = model
    if device != "auto":
        config.device = device
    policy = make_policy(config, ds_meta=dataset.meta)
    policy.eval()
    preprocessor, postprocessor = make_pre_post_processors(
        policy_cfg=config,
        pretrained_path=model,
        preprocessor_overrides={"device_processor": {"device": str(policy.config.device)}},
    )
    return policy, preprocessor, postprocessor


def infer(policy, preprocessor, postprocessor, observation: dict, task: str) -> np.ndarray:
    from lerobot.utils.control_utils import predict_action
    from lerobot.utils.utils import get_safe_torch_device

    output = predict_action(
        observation=observation,
        policy=policy,
        device=get_safe_torch_device(policy.config.device),
        preprocessor=preprocessor,
        postprocessor=postprocessor,
        use_amp=policy.config.use_amp,
        task=task,
        robot_type="ovphysx_ros",
    )
    action = output.squeeze(0).detach().cpu().numpy().astype(np.float32)
    if action.ndim != 1 or not np.all(np.isfinite(action)):
        raise RuntimeError(f"Policy returned an invalid action with shape {action.shape}")
    return action


def reset_policy(policy, preprocessor, postprocessor) -> None:
    for item in (policy, preprocessor, postprocessor):
        reset = getattr(item, "reset", None)
        if reset is not None:
            reset()


def aggregate(episodes: list[dict]) -> dict:
    successes = [bool(item["success"]) for item in episodes]
    latencies = [value for item in episodes for value in item["inference_ms"]]
    return {
        "episodes": len(episodes),
        "successes": sum(successes),
        "success_rate": float(np.mean(successes)) if successes else 0.0,
        "mean_final_error": float(np.mean([item["final_error"] for item in episodes])),
        "mean_inference_ms": float(np.mean(latencies)) if latencies else 0.0,
        "p95_inference_ms": float(np.percentile(latencies, 95)) if latencies else 0.0,
        "control_overruns": sum(item["control_overruns"] for item in episodes),
    }


def main() -> int:
    args = parse_args()
    validate_args(args)
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    simulation = RosSimulation(args)
    dataset = None
    try:
        sensors = simulation.discover_sensors()
        simulation.subscribe_sensors(sensors)
        simulation.wait_ready()
        goal = resolve_goal(args.goal, simulation.joint_names)
        dataset = LeRobotDataset.create(
            repo_id=args.repo_id,
            root=args.root.resolve(),
            fps=args.fps,
            robot_type="ovphysx_ros",
            features=make_features(simulation, args.use_videos),
            use_videos=args.use_videos,
        )
        policy, preprocessor, postprocessor = load_policy(args.model, args.device, dataset)
        rng = np.random.default_rng(args.seed)
        max_steps = max(1, round(args.duration * args.fps))
        episode_metrics = []
        for episode in range(args.episodes):
            reset_target = goal + rng.uniform(-args.random_radius, args.random_radius, goal.shape)
            reset_error = simulation.reset_to(reset_target.astype(np.float32))
            reset_policy(policy, preprocessor, postprocessor)
            errors: list[float] = []
            inference_ms: list[float] = []
            overruns = 0
            for _step in range(max_steps):
                started = time.perf_counter()
                observation = simulation.observation()
                action = infer(policy, preprocessor, postprocessor, observation, args.task)
                if action.shape != goal.shape:
                    raise RuntimeError(f"Policy action shape {action.shape} != robot action shape {goal.shape}")
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                inference_ms.append(elapsed_ms)
                if elapsed_ms > 1000.0 / args.fps:
                    overruns += 1
                dataset.add_frame({**observation, "action": action, "task": args.task})
                simulation.step(action)
                assert simulation.state is not None
                error = float(np.max(np.abs(simulation.state - goal)))
                errors.append(error)
                if args.stop_on_success and error <= args.success_tolerance:
                    break
            dataset.save_episode(parallel_encoding=False)
            metrics = {
                "episode": episode,
                "frames": len(errors),
                "reset_error": reset_error,
                "initial_goal_error": float(np.max(np.abs(reset_target - goal))),
                "minimum_error": min(errors),
                "final_error": errors[-1],
                "success": errors[-1] <= args.success_tolerance,
                "inference_ms": inference_ms,
                "control_overruns": overruns,
            }
            episode_metrics.append(metrics)
            print(json.dumps(metrics))
        dataset.finalize()
        dataset = None
        reopened = LeRobotDataset(repo_id=args.repo_id, root=args.root.resolve())
        report = {
            "model": args.model,
            "device": str(policy.config.device),
            "dataset_root": str(args.root.resolve()),
            "repo_id": args.repo_id,
            "task": args.task,
            "goal": goal.astype(float).tolist(),
            "joint_names": simulation.joint_names,
            "sensors": sensors,
            "dataset_episodes": reopened.num_episodes,
            "dataset_frames": reopened.num_frames,
            "aggregate": aggregate(episode_metrics),
            "episode_metrics": episode_metrics,
        }
        (args.root / "evaluation.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(report["aggregate"], ensure_ascii=False, indent=2))
    finally:
        if dataset is not None:
            dataset.finalize()
        simulation.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
