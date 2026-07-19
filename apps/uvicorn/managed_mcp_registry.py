"""Registry for first-party MCP adapters stored under the repo/root mcps directory."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Callable


def mcps_root() -> Path:
    configured = os.getenv("SILVERRETORT_MCPS_ROOT", "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / "mcps"


def adapter_path(adapter_id: str) -> Path:
    if not adapter_id.replace("_", "").replace("-", "").isalnum():
        raise ValueError(f"invalid managed MCP adapter id: {adapter_id}")
    return mcps_root() / adapter_id / "adapter.py"


def load_adapter_module(adapter_id: str) -> ModuleType:
    path = adapter_path(adapter_id)
    if not path.is_file():
        raise KeyError(f"unknown managed MCP adapter: {adapter_id}")
    spec = importlib.util.spec_from_file_location(f"silverretort_managed_mcp_{adapter_id}", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load managed MCP adapter: {adapter_id}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_adapter_main(adapter_id: str) -> Callable[[list[str] | None], None]:
    module = load_adapter_module(adapter_id)
    main = getattr(module, "main", None)
    if not callable(main):
        raise RuntimeError(f"managed MCP adapter {adapter_id} does not export main(argv)")
    return main
