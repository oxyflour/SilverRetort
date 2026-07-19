"""Workspace port HTTP and WebSocket proxy routes."""

import asyncio
import os
from contextlib import suppress

import httpx
from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse
from websockets.asyncio.client import connect

import db
import switch_profiles
import workspace_service

router = APIRouter()
HTTP_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def _filter_proxy_headers(headers) -> dict[str, str]:
    return {
        key: value
        for key, value in dict(headers.items()).items()
        if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "authorization"
    }


def _remote_auth_headers(headers=None) -> dict[str, str]:
    result = _filter_proxy_headers(headers or {})
    api_key = os.getenv("HERMES_API_KEY", "").strip()
    if api_key:
        result["authorization"] = f"Bearer {api_key}"
    return result


def _remote_auth_headers_for_workspace(workspace_id: str, headers=None) -> dict[str, str]:
    result = _filter_proxy_headers(headers or {})
    workspace = db.get_workspace(workspace_id)
    connection = switch_profiles.connection_for_profile(
        workspace.connection_id if workspace is not None else None
    )
    if connection.api_key:
        result["authorization"] = f"Bearer {connection.api_key}"
    return result


def _validate_workspace_proxy_request(workspace_id: str, port: int) -> None:
    if db.get_workspace(workspace_id) is None:
        raise HTTPException(404, "workspace not found")
    if port < 1 or port > 65535:
        raise HTTPException(400, "invalid port")


async def _stream_remote_proxy_response(client: httpx.AsyncClient, response: httpx.Response):
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()
        await client.aclose()


async def _proxy_workspace_port_http(workspace_id: str, port: int, request: Request, path: str = ""):
    _validate_workspace_proxy_request(workspace_id, port)
    try:
        await workspace_service.require_workspace_proxy(workspace_id)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10))
    upstream = client.build_request(
        request.method,
        workspace_service.remote_workspace_proxy_url(workspace_id, port, path, request.url.query),
        headers=_remote_auth_headers_for_workspace(workspace_id, request.headers),
        content=await request.body(),
    )
    try:
        response = await client.send(upstream, stream=True)
    except Exception:
        await client.aclose()
        raise
    return StreamingResponse(
        _stream_remote_proxy_response(client, response),
        status_code=response.status_code,
        headers=_filter_proxy_headers(response.headers),
    )


async def _browser_to_remote(websocket: WebSocket, remote) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            await remote.close()
            return
        if message.get("bytes") is not None:
            await remote.send(message["bytes"])
        elif message.get("text") is not None:
            await remote.send(message["text"])


async def _remote_to_browser(websocket: WebSocket, remote) -> None:
    async for message in remote:
        if isinstance(message, bytes):
            await websocket.send_bytes(message)
        else:
            await websocket.send_text(message)


async def _proxy_workspace_port_websocket(websocket: WebSocket, workspace_id: str, port: int, path: str = ""):
    try:
        _validate_workspace_proxy_request(workspace_id, port)
        await workspace_service.require_workspace_proxy(workspace_id)
    except (HTTPException, RuntimeError) as exc:
        reason = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        await websocket.close(code=1013, reason=reason)
        return

    await websocket.accept()
    try:
        async with connect(
            workspace_service.remote_workspace_proxy_ws_url(workspace_id, port, path, websocket.url.query),
            additional_headers=_remote_auth_headers_for_workspace(workspace_id),
        ) as remote:
            tasks = {
                asyncio.create_task(_browser_to_remote(websocket, remote)),
                asyncio.create_task(_remote_to_browser(websocket, remote)),
            }
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
            with suppress(Exception):
                await remote.close()
    except Exception:
        return
    finally:
        with suppress(RuntimeError):
            await websocket.close()


router.api_route(
    "/workspace-proxy/workspace/{workspace_id}/port/{port}",
    methods=HTTP_METHODS,
)(_proxy_workspace_port_http)
router.api_route(
    "/workspace-proxy/workspace/{workspace_id}/port/{port}/{path:path}",
    methods=HTTP_METHODS,
)(_proxy_workspace_port_http)
router.websocket("/workspace-proxy/workspace/{workspace_id}/port/{port}")(_proxy_workspace_port_websocket)
router.websocket("/workspace-proxy/workspace/{workspace_id}/port/{port}/{path:path}")(_proxy_workspace_port_websocket)
