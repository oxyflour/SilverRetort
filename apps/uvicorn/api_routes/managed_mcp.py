"""Managed local MCP adapter routes.

The desktop process owns long-lived adapter processes. Uvicorn exposes the
stable REST API, proxies lifecycle actions to desktop, and refreshes the
Hermes bridge after changes that affect visible MCP server names.
"""

import os
from typing import Any

import httpx
from fastapi import APIRouter, Body, HTTPException

import bridge_client

router = APIRouter()


def _desktop_control() -> tuple[str, dict[str, str]]:
    base_url = os.getenv("DESKTOP_CONTROL_URL", "").strip().rstrip("/")
    token = os.getenv("DESKTOP_CONTROL_TOKEN", "").strip()
    if not base_url or not token:
        raise HTTPException(503, "desktop managed MCP control is unavailable")
    return base_url, {"Authorization": f"Bearer {token}"}


async def _control_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    base_url, headers = _desktop_control()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as client:
            response = await client.request(method, f"{base_url}{path}", headers=headers, json=body)
    except Exception as exc:
        raise HTTPException(503, f"desktop managed MCP control failed: {exc}") from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {"error": response.text}
    if response.status_code >= 400:
        raise HTTPException(response.status_code, str(payload.get("error") or "managed MCP request failed"))
    return payload if isinstance(payload, dict) else {}


async def _refresh_after(payload: dict[str, Any]) -> dict[str, Any]:
    await bridge_client.refresh_local_mcp_servers()
    return payload


@router.get("/hermes/managed-mcp/catalog")
async def managed_mcp_catalog() -> dict[str, Any]:
    return await _control_request("GET", "/managed-mcp/catalog")


@router.get("/hermes/managed-mcp")
async def managed_mcp_list() -> dict[str, Any]:
    return await _control_request("GET", "/managed-mcp")


@router.post("/hermes/managed-mcp/{server_id}/install")
async def managed_mcp_install(server_id: str, body: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    return await _refresh_after(await _control_request("POST", f"/managed-mcp/{server_id}/install", body or {}))


@router.post("/hermes/managed-mcp/{server_id}/start")
async def managed_mcp_start(server_id: str) -> dict[str, Any]:
    return await _refresh_after(await _control_request("POST", f"/managed-mcp/{server_id}/start", {}))


@router.post("/hermes/managed-mcp/{server_id}/stop")
async def managed_mcp_stop(server_id: str) -> dict[str, Any]:
    return await _refresh_after(await _control_request("POST", f"/managed-mcp/{server_id}/stop", {}))


@router.patch("/hermes/managed-mcp/{server_id}")
async def managed_mcp_patch(server_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return await _refresh_after(await _control_request("PATCH", f"/managed-mcp/{server_id}", body))


@router.delete("/hermes/managed-mcp/{server_id}")
async def managed_mcp_delete(server_id: str) -> dict[str, Any]:
    return await _refresh_after(await _control_request("DELETE", f"/managed-mcp/{server_id}"))
