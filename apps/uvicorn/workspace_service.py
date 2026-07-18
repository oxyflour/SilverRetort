"""Local/remote workspace storage access with one confinement policy."""

import mimetypes
import os
import time
from pathlib import Path, PurePosixPath
from typing import AsyncIterator
from urllib.parse import quote
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import UploadFile

import db
import switch_profiles

WORKSPACE_PROXY_ERROR = "workspace port proxy requires newer remote Hermes relay"
WORKSPACE_PROXY_CACHE_SECONDS = 5
_workspace_proxy_cache: dict[str, tuple[float, bool]] = {}


def _connection(workspace_id: str | None = None) -> switch_profiles.SwitchConnection:
    workspace = db.get_workspace(workspace_id) if workspace_id else None
    return switch_profiles.connection_for_profile(
        workspace.connection_id if workspace is not None else None
    )


def _cache_key(workspace_id: str | None = None) -> str:
    connection = _connection(workspace_id)
    return f"{connection.mode}:{connection.switch_url}"


def _base_url(workspace_id: str | None = None) -> str:
    return _connection(workspace_id).switch_url.rstrip("/")


def _headers(workspace_id: str | None = None) -> dict[str, str]:
    key = _connection(workspace_id).api_key.strip()
    return {"authorization": f"Bearer {key}"} if key else {}


def _local_root(workspace_id: str | None = None) -> Path | None:
    value = _connection(workspace_id).local_workspaces_dir.strip()
    return Path(value).resolve() if value else None


def normalize_relative_path(raw: str) -> str:
    value = raw.replace("\\", "/").strip()
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid workspace-relative path")
    if len(path.parts[0]) == 2 and path.parts[0][1] == ":":
        raise ValueError("absolute paths are not allowed")
    return path.as_posix()


def resolve_artifact_asset(entry_path: str, asset_path: str | None = None) -> str:
    entry = PurePosixPath(normalize_relative_path(entry_path))
    if not asset_path:
        return entry.as_posix()
    asset = PurePosixPath(normalize_relative_path(asset_path))
    resolved = entry.parent / asset
    if not resolved.is_relative_to(entry.parent):
        raise ValueError("artifact asset escapes entry directory")
    return resolved.as_posix()


def local_file_path(workspace_id: str, relative_path: str) -> Path | None:
    root = _local_root(workspace_id)
    if root is None:
        return None
    if not workspace_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for char in workspace_id):
        raise ValueError("invalid workspace id")
    workspace = (root / workspace_id).resolve()
    if (root / workspace_id).is_symlink() or not workspace.is_relative_to(root):
        raise ValueError("workspace escapes local root")
    candidate = workspace.joinpath(*PurePosixPath(normalize_relative_path(relative_path)).parts)
    resolved = candidate.resolve()
    if not resolved.is_relative_to(workspace) or candidate.is_symlink():
        raise ValueError("path escapes workspace")
    return resolved


def _metadata(workspace_id: str, relative_path: str, size: int, mime_type: str | None = None) -> dict:
    normalized = normalize_relative_path(relative_path)
    name = PurePosixPath(normalized).name
    mime = mime_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {
        "workspaceId": workspace_id,
        "relativePath": normalized,
        "name": name,
        "mimeType": mime,
        "size": size,
        "kind": "image" if mime.startswith("image/") else "file",
    }


def remote_file_url(workspace_id: str, relative_path: str) -> str:
    encoded = "/".join(quote(part, safe="") for part in normalize_relative_path(relative_path).split("/"))
    return f"{_base_url(workspace_id)}/workspace-api/workspaces/{quote(workspace_id)}/files/{encoded}"


def _workspace_proxy_path(workspace_id: str, port: int, path: str = "") -> str:
    suffix = "/".join(quote(part, safe="") for part in path.strip("/").split("/") if part)
    base = f"/workspace-proxy/workspace/{quote(workspace_id)}/port/{port}"
    if not suffix:
        return f"{base}/"
    return f"{base}/{suffix}/" if path.endswith("/") else f"{base}/{suffix}"


def remote_workspace_proxy_url(workspace_id: str, port: int, path: str = "", query: str = "") -> str:
    url = f"{_base_url(workspace_id)}{_workspace_proxy_path(workspace_id, port, path)}"
    return f"{url}?{query}" if query else url


def remote_workspace_proxy_ws_url(workspace_id: str, port: int, path: str = "", query: str = "") -> str:
    parsed = urlsplit(remote_workspace_proxy_url(workspace_id, port, path, query))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))


def local_workspace_proxy_url(workspace_id: str, port: int, path: str = "", query: str = "") -> str:
    listen_port = int(os.getenv("LISTEN_PORT", "23001"))
    url = f"http://127.0.0.1:{listen_port}/api{_workspace_proxy_path(workspace_id, port, path)}"
    return f"{url}?{query}" if query else url


def _has_workspace_proxy(payload: dict) -> bool:
    proxy = payload.get("workspaceProxy")
    if not isinstance(proxy, dict):
        return False
    try:
        version = int(proxy.get("version") or 0)
    except (TypeError, ValueError):
        return False
    return (
        proxy.get("supported") is True
        and version >= 1
        and proxy.get("http") is True
        and proxy.get("websocket") is True
    )


def _cached_workspace_proxy_supported(workspace_id: str | None = None) -> bool | None:
    cached_item = _workspace_proxy_cache.get(_cache_key(workspace_id))
    if cached_item is None:
        return None
    expires_at, supported = cached_item
    return supported if time.monotonic() < expires_at else None


def _set_workspace_proxy_cache(supported: bool, workspace_id: str | None = None) -> bool:
    _workspace_proxy_cache[_cache_key(workspace_id)] = (
        time.monotonic() + WORKSPACE_PROXY_CACHE_SECONDS,
        supported,
    )
    return supported


async def workspace_proxy_supported(workspace_id: str | None = None) -> bool:
    cached = _cached_workspace_proxy_supported(workspace_id)
    if cached is not None:
        return cached
    if not _base_url(workspace_id):
        return _set_workspace_proxy_cache(False, workspace_id)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{_base_url(workspace_id)}/workspace-api/capability", headers=_headers(workspace_id))
            response.raise_for_status()
            return _set_workspace_proxy_cache(_has_workspace_proxy(response.json()), workspace_id)
    except (httpx.HTTPError, ValueError):
        return _set_workspace_proxy_cache(False, workspace_id)


def workspace_proxy_supported_sync(workspace_id: str | None = None) -> bool:
    cached = _cached_workspace_proxy_supported(workspace_id)
    if cached is not None:
        return cached
    if not _base_url(workspace_id):
        return _set_workspace_proxy_cache(False, workspace_id)
    try:
        with httpx.Client(timeout=10) as client:
            response = client.get(f"{_base_url(workspace_id)}/workspace-api/capability", headers=_headers(workspace_id))
            response.raise_for_status()
            return _set_workspace_proxy_cache(_has_workspace_proxy(response.json()), workspace_id)
    except (httpx.HTTPError, ValueError):
        return _set_workspace_proxy_cache(False, workspace_id)


async def require_workspace_proxy(workspace_id: str | None = None) -> None:
    if not await workspace_proxy_supported(workspace_id):
        raise RuntimeError(WORKSPACE_PROXY_ERROR)


def require_workspace_proxy_sync(workspace_id: str | None = None) -> str | None:
    return None if workspace_proxy_supported_sync(workspace_id) else WORKSPACE_PROXY_ERROR


async def capability(workspace_id: str | None = None) -> dict:
    if _local_root(workspace_id) is not None:
        result = {"supported": True, "version": 1, "writable": True, "cwdEnforced": False}
        if await workspace_proxy_supported(workspace_id):
            result["workspaceProxy"] = {
                "supported": True,
                "version": 1,
                "http": True,
                "websocket": True,
                "pathPrefixRequired": True,
            }
        return result
    if not _base_url(workspace_id):
        return {"supported": False, "version": 0, "writable": False, "cwdEnforced": False}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{_base_url(workspace_id)}/workspace-api/capability", headers=_headers(workspace_id))
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, ValueError):
        return {"supported": False, "version": 0, "writable": False, "cwdEnforced": False}


async def create_remote(workspace_id: str) -> None:
    local_root = _local_root(workspace_id)
    if local_root is not None:
        (local_root / workspace_id).mkdir(parents=True, exist_ok=True)
        return
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.put(f"{_base_url(workspace_id)}/workspace-api/workspaces/{quote(workspace_id)}", headers=_headers(workspace_id))
        response.raise_for_status()


async def delete_remote(workspace_id: str) -> None:
    local_root = _local_root(workspace_id)
    if local_root is not None:
        import shutil
        path = local_root / workspace_id
        if path.is_dir():
            shutil.rmtree(path)
        return
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.delete(f"{_base_url(workspace_id)}/workspace-api/workspaces/{quote(workspace_id)}", headers=_headers(workspace_id))
        response.raise_for_status()


async def upload_file(workspace_id: str, file: UploadFile) -> dict:
    root = _local_root(workspace_id)
    filename = Path((file.filename or "upload").replace("\\", "/")).name or "upload"
    if root is not None:
        upload_dir = root / workspace_id / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        target = upload_dir / filename
        counter = 2
        while target.exists():
            target = upload_dir / f"{Path(filename).stem}-{counter}{Path(filename).suffix}"
            counter += 1
        size = 0
        try:
            with target.open("xb") as output:
                while chunk := await file.read(1024 * 1024):
                    output.write(chunk)
                    size += len(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return _metadata(workspace_id, target.relative_to(root / workspace_id).as_posix(), size, file.content_type)

    async def chunks() -> AsyncIterator[bytes]:
        while chunk := await file.read(1024 * 1024):
            yield chunk

    headers = _headers(workspace_id) | {
        "content-type": file.content_type or "application/octet-stream",
        "x-silverretort-filename": quote(filename, safe=""),
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as client:
        response = await client.post(
            f"{_base_url(workspace_id)}/workspace-api/workspaces/{quote(workspace_id)}/files",
            headers=headers, content=chunks(),
        )
        response.raise_for_status()
        result = response.json()
    return _metadata(workspace_id, str(result["relativePath"]), int(result["size"]), file.content_type)


async def stat_workspace_file(workspace_id: str, relative_path: str) -> dict:
    local = local_file_path(workspace_id, relative_path)
    if local is not None:
        if not local.is_file():
            raise FileNotFoundError(relative_path)
        return _metadata(workspace_id, relative_path, local.stat().st_size)
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.head(remote_file_url(workspace_id, relative_path), headers=_headers(workspace_id))
        if response.status_code == 404:
            raise FileNotFoundError(relative_path)
        response.raise_for_status()
        return _metadata(
            workspace_id, relative_path, int(response.headers.get("content-length", "0")),
            response.headers.get("content-type", "").split(";", 1)[0] or None,
        )


def stat_workspace_file_sync(workspace_id: str, relative_path: str) -> dict:
    local = local_file_path(workspace_id, relative_path)
    if local is not None:
        if not local.is_file():
            raise FileNotFoundError(relative_path)
        return _metadata(workspace_id, relative_path, local.stat().st_size)
    with httpx.Client(timeout=15) as client:
        response = client.head(remote_file_url(workspace_id, relative_path), headers=_headers(workspace_id))
        if response.status_code == 404:
            raise FileNotFoundError(relative_path)
        response.raise_for_status()
        return _metadata(
            workspace_id, relative_path, int(response.headers.get("content-length", "0")),
            response.headers.get("content-type", "").split(";", 1)[0] or None,
        )


async def list_workspace_files(workspace_id: str) -> list[dict]:
    root = _local_root(workspace_id)
    if root is not None:
        workspace = (root / workspace_id).resolve()
        if not workspace.is_dir():
            raise FileNotFoundError(workspace_id)
        return [
            await stat_workspace_file(workspace_id, path.relative_to(workspace).as_posix())
            for path in workspace.rglob("*") if path.is_file() and not path.is_symlink()
        ]
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{_base_url(workspace_id)}/workspace-api/workspaces/{quote(workspace_id)}/files",
            headers=_headers(workspace_id),
        )
        response.raise_for_status()
        return list(response.json())


async def open_remote_file(workspace_id: str, relative_path: str) -> tuple[httpx.AsyncClient, httpx.Response]:
    client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10))
    response = await client.send(
        client.build_request("GET", remote_file_url(workspace_id, relative_path), headers=_headers(workspace_id)),
        stream=True,
    )
    return client, response
