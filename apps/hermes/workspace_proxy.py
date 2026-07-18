"""Workspace-scoped loopback port proxy for relay mode."""

import asyncio
from contextlib import suppress
from typing import Any

import aiohttp
from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

import workspaces

HOP_BY_HOP_HEADERS = {
    "authorization",
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
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _bearer_token(headers: Any) -> str:
    header = headers.get("authorization", "")
    prefix = "bearer "
    if header.lower().startswith(prefix):
        return header[len(prefix) :].strip()
    return ""


def _authorized_request(request: Request, api_key: str) -> bool:
    if not api_key.strip():
        return True
    if request.client and request.client.host.lower() in LOOPBACK_HOSTS:
        return True
    return _bearer_token(request.headers) == api_key.strip()


def _authorized_websocket(websocket: WebSocket, api_key: str) -> bool:
    if not api_key.strip():
        return True
    if websocket.client and websocket.client.host.lower() in LOOPBACK_HOSTS:
        return True
    return _bearer_token(websocket.headers) == api_key.strip()


def _filter_headers(headers: Any) -> dict[str, str]:
    return {
        key: value
        for key, value in dict(headers.items()).items()
        if key.lower() not in HOP_BY_HOP_HEADERS and not key.lower().startswith("sec-websocket-")
    }


def _validate_target(workspace_id: str, port: int) -> None:
    try:
        workspace = workspaces.workspace_dir(workspace_id, create=False)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not workspace.is_dir():
        raise HTTPException(404, "workspace not found")
    if port < 1 or port > 65535:
        raise HTTPException(400, "invalid port")


def _target_url(scheme: str, port: int, path: str, query: str = "") -> str:
    suffix = path.lstrip("/")
    url = f"{scheme}://127.0.0.1:{port}/{suffix}" if suffix else f"{scheme}://127.0.0.1:{port}/"
    return f"{url}?{query}" if query else url


async def _stream_proxy_response(response: Any):
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()


async def _proxy_http(workspace_id: str, port: int, request: Request, path: str = ""):
    if not _authorized_request(request, request.app.state.bridge_api_key):
        return PlainTextResponse("unauthorized", status_code=401)
    _validate_target(workspace_id, port)
    state = request.app.state.relay_state
    upstream = state.http.build_request(
        request.method,
        _target_url("http", port, path, request.url.query),
        headers=_filter_headers(request.headers),
        content=await request.body(),
    )
    response = await state.http.send(upstream, stream=True)
    return StreamingResponse(
        _stream_proxy_response(response),
        status_code=response.status_code,
        headers=_filter_headers(response.headers),
    )


async def _client_to_target(websocket: WebSocket, target: aiohttp.ClientWebSocketResponse) -> None:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            await target.close()
            return
        if message.get("bytes") is not None:
            await target.send_bytes(message["bytes"])
        elif message.get("text") is not None:
            await target.send_str(message["text"])


async def _target_to_client(websocket: WebSocket, target: aiohttp.ClientWebSocketResponse) -> None:
    async for message in target:
        if message.type == aiohttp.WSMsgType.TEXT:
            await websocket.send_text(message.data)
        elif message.type == aiohttp.WSMsgType.BINARY:
            await websocket.send_bytes(message.data)
        elif message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
            break


async def _proxy_websocket(websocket: WebSocket, workspace_id: str, port: int, path: str = "") -> None:
    app = websocket.scope["app"]
    if not _authorized_websocket(websocket, app.state.bridge_api_key):
        await websocket.close(code=4401, reason="unauthorized")
        return
    try:
        _validate_target(workspace_id, port)
    except HTTPException as exc:
        await websocket.close(code=1008, reason=str(exc.detail))
        return

    await websocket.accept()
    async with aiohttp.ClientSession() as session:
        try:
            async with session.ws_connect(
                _target_url("ws", port, path, websocket.url.query),
                headers=_filter_headers(websocket.headers),
            ) as target:
                tasks = {
                    asyncio.create_task(_client_to_target(websocket, target)),
                    asyncio.create_task(_target_to_client(websocket, target)),
                }
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                for task in done:
                    task.result()
                with suppress(Exception):
                    await target.close()
        except (aiohttp.ClientError, RuntimeError, WebSocketDisconnect):
            return
        finally:
            with suppress(RuntimeError):
                await websocket.close()


def register_workspace_proxy_routes(app: FastAPI, methods: list[str]) -> None:
    app.api_route(
        "/workspace-proxy/workspace/{workspace_id}/port/{port}",
        methods=methods,
    )(_proxy_http)
    app.api_route(
        "/workspace-proxy/workspace/{workspace_id}/port/{port}/{path:path}",
        methods=methods,
    )(_proxy_http)
    app.websocket("/workspace-proxy/workspace/{workspace_id}/port/{port}")(_proxy_websocket)
    app.websocket("/workspace-proxy/workspace/{workspace_id}/port/{port}/{path:path}")(_proxy_websocket)
