"""Hermes-side workspace storage with strict path confinement."""

import os
import re
import shutil
from pathlib import Path, PurePosixPath

WORKSPACE_ID = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")


def root_dir() -> Path:
    root = Path(os.getenv("HERMES_WORKSPACES_DIR", Path(__file__).parent / "workspace-data"))
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def workspace_dir(workspace_id: str, create: bool = False) -> Path:
    if not WORKSPACE_ID.fullmatch(workspace_id):
        raise ValueError("invalid workspace id")
    path = root_dir() / workspace_id
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def safe_relative_path(raw: str) -> PurePosixPath:
    value = raw.replace("\\", "/").strip()
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid relative path")
    return path


def file_path(workspace_id: str, relative_path: str) -> Path:
    workspace = workspace_dir(workspace_id)
    relative = safe_relative_path(relative_path)
    candidate = workspace.joinpath(*relative.parts)
    resolved_parent = candidate.parent.resolve()
    if not resolved_parent.is_relative_to(workspace.resolve()):
        raise ValueError("path escapes workspace")
    return candidate


def unique_upload_path(workspace_id: str, filename: str) -> tuple[Path, str]:
    safe_name = Path(filename.replace("\\", "/")).name.strip() or "upload"
    target_dir = workspace_dir(workspace_id, create=True) / "uploads"
    target_dir.mkdir(parents=True, exist_ok=True)
    stem, suffix = Path(safe_name).stem, Path(safe_name).suffix
    target = target_dir / safe_name
    counter = 2
    while target.exists():
        target = target_dir / f"{stem}-{counter}{suffix}"
        counter += 1
    return target, target.relative_to(workspace_dir(workspace_id)).as_posix()


def delete_workspace(workspace_id: str) -> None:
    path = workspace_dir(workspace_id)
    if path.exists():
        shutil.rmtree(path)
