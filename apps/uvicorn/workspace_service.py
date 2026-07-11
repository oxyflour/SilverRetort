"""Coordinates local workspace metadata with Hermes-side storage."""

import os
from typing import AsyncIterator
from urllib.parse import quote

import httpx
from fastapi import UploadFile


def _base_url() -> str:
    return os.getenv("HERMES_URL", "").rstrip("/")


def _headers() -> dict[str, str]:
    key = os.getenv("HERMES_API_KEY", "").strip()
    return {"authorization": f"Bearer {key}"} if key else {}


async def capability() -> dict:
    if not _base_url():
        return {"supported": False, "version": 0, "writable": False, "cwdEnforced": False}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{_base_url()}/workspace-api/capability", headers=_headers())
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, ValueError):
        return {"supported": False, "version": 0, "writable": False, "cwdEnforced": False}


async def create_remote(workspace_id: str) -> None:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.put(
            f"{_base_url()}/workspace-api/workspaces/{quote(workspace_id)}", headers=_headers()
        )
        response.raise_for_status()


async def delete_remote(workspace_id: str) -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.delete(
            f"{_base_url()}/workspace-api/workspaces/{quote(workspace_id)}", headers=_headers()
        )
        response.raise_for_status()


async def upload_remote(workspace_id: str, file: UploadFile) -> dict:
    async def chunks() -> AsyncIterator[bytes]:
        while chunk := await file.read(1024 * 1024):
            yield chunk

    filename = file.filename or "upload"
    headers = _headers() | {
        "content-type": file.content_type or "application/octet-stream",
        "x-silverretort-filename": filename,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as client:
        response = await client.post(
            f"{_base_url()}/workspace-api/workspaces/{quote(workspace_id)}/files",
            headers=headers, content=chunks(),
        )
        response.raise_for_status()
        return response.json()


def remote_file_url(workspace_id: str, relative_path: str) -> str:
    encoded = "/".join(quote(part, safe="") for part in relative_path.split("/"))
    return f"{_base_url()}/workspace-api/workspaces/{quote(workspace_id)}/files/{encoded}"
