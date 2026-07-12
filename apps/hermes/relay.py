"""Relay server for remote Hermes deployments.

When enabled, the relay fronts the public Hermes API, proxies requests to the
internal gateway, exposes a local MCP endpoint for Hermes, and accepts a
reverse bridge connection from uvicorn for tool execution.
"""

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import unquote

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response, StreamingResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

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
TOOL_TIMEOUT_SECONDS = 60
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

import workspaces


def _strip_base_url(raw_url: str) -> str:
    return raw_url.rstrip("/")


def _bearer_token(headers: Any) -> str:
    header = headers.get("authorization", "")
    prefix = "bearer "
    if header.lower().startswith(prefix):
        return header[len(prefix) :].strip()
    return ""


def _is_loopback_client(scope: dict[str, Any]) -> bool:
    client = scope.get("client")
    if not client:
        return False
    host = str(client[0] or "").lower()
    return host in LOOPBACK_HOSTS


def _filter_headers(headers: httpx.Headers | dict[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }


class LoopbackOrBearerAuthApp:
    def __init__(self, app: Any, api_key: str) -> None:
        self.app = app
        self.api_key = api_key.strip()

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if not self.api_key or _is_loopback_client(scope):
            await self.app(scope, receive, send)
            return

        headers = {key.decode("latin-1"): value.decode("latin-1") for key, value in scope["headers"]}
        if _bearer_token(headers) == self.api_key:
            await self.app(scope, receive, send)
            return

        response = PlainTextResponse("unauthorized", status_code=401)
        await response(scope, receive, send)


class BridgeSession:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._closed = asyncio.Event()
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._send_lock = asyncio.Lock()

    async def send_request(self, name: str, args: dict[str, Any]) -> Any:
        if self._closed.is_set():
            raise RuntimeError("bridge disconnected")

        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            async with self._send_lock:
                await self.websocket.send_json({"id": request_id, "name": name, "args": args})
            return await asyncio.wait_for(future, timeout=TOOL_TIMEOUT_SECONDS)
        finally:
            self._pending.pop(request_id, None)

    async def run(self) -> None:
        error: Exception | None = None
        try:
            while True:
                payload = await self.websocket.receive_json()
                if not isinstance(payload, dict):
                    continue
                request_id = str(payload.get("id") or "")
                future = self._pending.get(request_id)
                if future is None or future.done():
                    continue
                if payload.get("ok"):
                    future.set_result(payload.get("result"))
                else:
                    future.set_exception(RuntimeError(str(payload.get("error") or "bridge call failed")))
        except WebSocketDisconnect as exc:
            error = RuntimeError(f"bridge disconnected: {exc.code}")
        except Exception as exc:
            error = exc
        finally:
            self._closed.set()
            await self._fail_all(error or RuntimeError("bridge disconnected"))

    async def close(self, code: int = 1012, reason: str = "replaced") -> None:
        self._closed.set()
        await self._fail_all(RuntimeError(reason))
        try:
            await self.websocket.close(code=code, reason=reason)
        except RuntimeError:
            return

    async def _fail_all(self, error: Exception) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)
        self._pending.clear()


class BridgeRegistry:
    def __init__(self) -> None:
        self._active: BridgeSession | None = None
        self._lock = asyncio.Lock()

    async def attach(self, session: BridgeSession) -> None:
        previous: BridgeSession | None
        async with self._lock:
            previous = self._active
            self._active = session
        if previous is not None:
            await previous.close()

    async def detach(self, session: BridgeSession) -> None:
        async with self._lock:
            if self._active is session:
                self._active = None

    async def call_tool(self, name: str, args: dict[str, Any]) -> Any:
        async with self._lock:
            session = self._active
        if session is None:
            raise RuntimeError("bridge unavailable")
        return await session.send_request(name, args)


class RelayState:
    def __init__(self, bridge: BridgeRegistry, gateway_base_url: str) -> None:
        self.bridge = bridge
        self.gateway_base_url = _strip_base_url(gateway_base_url)
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10))


def _create_mcp_server(bridge: BridgeRegistry) -> FastMCP:
    mcp = FastMCP("silverretort-ui", stateless_http=True, streamable_http_path="/")

    @mcp.tool()
    async def ui_show_artifact(
        session_id: str, type: str, title: str, payload: dict[str, Any] | None = None
    ) -> str:
        return str(
            await bridge.call_tool(
                "ui_show_artifact",
                {"session_id": session_id, "type": type, "title": title, "payload": payload},
            )
        )

    @mcp.tool()
    async def ui_update_artifact(artifact_id: str, payload: dict[str, Any]) -> str:
        return str(
            await bridge.call_tool(
                "ui_update_artifact",
                {"artifact_id": artifact_id, "payload": payload},
            )
        )

    @mcp.tool()
    async def ui_list_render_types() -> list[str]:
        result = await bridge.call_tool("ui_list_render_types", {})
        return list(result) if isinstance(result, list) else []

    return mcp


async def _stream_proxy_response(response: httpx.Response) -> Any:
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()


async def _proxy_request(request: Request) -> Response:
    state: RelayState = request.app.state.relay_state
    target = f"{state.gateway_base_url}{request.url.path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    body = await request.body()
    if request.url.path == "/v1/responses" and body:
        try:
            payload = json.loads(body)
            workspace_id = str(payload.pop("workspace_id", ""))
            if workspace_id:
                workspace_path = workspaces.workspace_dir(workspace_id, create=False)
                if not workspace_path.is_dir():
                    raise HTTPException(404, "workspace not found")
                suffix = (
                    f"\nHermes workspace root: {workspace_path}. "
                    "Use this as the working directory for all shell and file operations; do not access paths outside it."
                )
                payload["instructions"] = str(payload.get("instructions") or "") + suffix
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        except json.JSONDecodeError:
            pass
    upstream = state.http.build_request(
        request.method,
        target,
        headers=_filter_headers(dict(request.headers.items())),
        content=body,
    )
    response = await state.http.send(upstream, stream=True)
    return StreamingResponse(
        _stream_proxy_response(response),
        status_code=response.status_code,
        headers=_filter_headers(response.headers),
    )


async def _bridge_endpoint(websocket: WebSocket) -> None:
    app = websocket.scope["app"]
    api_key = app.state.bridge_api_key
    if api_key and _bearer_token(websocket.headers) != api_key:
        await websocket.close(code=4401, reason="unauthorized")
        return

    await websocket.accept()
    state: RelayState = app.state.relay_state
    session = BridgeSession(websocket)
    await state.bridge.attach(session)
    try:
        await session.run()
    finally:
        await state.bridge.detach(session)


def create_relay_app(gateway_base_url: str, api_key: str) -> FastAPI:
    bridge = BridgeRegistry()
    mcp = _create_mcp_server(bridge)
    protected_mcp = LoopbackOrBearerAuthApp(mcp.streamable_http_app(), api_key)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.bridge_api_key = api_key.strip()
        app.state.relay_state = RelayState(bridge, gateway_base_url)
        try:
            async with mcp.session_manager.run():
                yield
        finally:
            await app.state.relay_state.http.aclose()

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def protect_workspace_api(request: Request, call_next: Any):
        if request.url.path.startswith("/workspace-api") or request.url.path.startswith("/silverretort/"):
            client_host = request.client.host.lower() if request.client else ""
            if api_key.strip() and client_host not in LOOPBACK_HOSTS and _bearer_token(request.headers) != api_key.strip():
                return PlainTextResponse("unauthorized", status_code=401)
        return await call_next(request)

    from silverretort_api import register_silverretort_routes
    register_silverretort_routes(app, api_key)

    @app.get("/workspace-api/capability")
    async def workspace_capability() -> dict[str, Any]:
        root = workspaces.root_dir()
        return {"supported": True, "version": 1, "writable": os.access(root, os.W_OK), "cwdEnforced": False}

    @app.put("/workspace-api/workspaces/{workspace_id}")
    async def create_workspace(workspace_id: str) -> dict[str, str]:
        try:
            path = workspaces.workspace_dir(workspace_id, create=True)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"id": workspace_id, "path": str(path)}

    @app.delete("/workspace-api/workspaces/{workspace_id}")
    async def delete_workspace(workspace_id: str) -> dict[str, bool]:
        try:
            workspaces.delete_workspace(workspace_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"ok": True}

    @app.post("/workspace-api/workspaces/{workspace_id}/files")
    async def upload_workspace_file(workspace_id: str, request: Request) -> dict[str, Any]:
        filename = unquote(request.headers.get("x-silverretort-filename", "upload"))
        try:
            target, relative_path = workspaces.unique_upload_path(workspace_id, filename)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        size = 0
        try:
            with target.open("xb") as output:
                async for chunk in request.stream():
                    output.write(chunk)
                    size += len(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return {"relativePath": relative_path, "size": size}

    @app.get("/workspace-api/workspaces/{workspace_id}/files")
    async def list_workspace_files(workspace_id: str) -> list[dict[str, Any]]:
        try:
            return workspaces.list_files(workspace_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(404, "workspace not found") from exc

    async def workspace_file_response(workspace_id: str, relative_path: str):
        try:
            path = workspaces.file_path(workspace_id, relative_path)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not path.is_file():
            raise HTTPException(404, "file not found")
        from starlette.responses import FileResponse
        return FileResponse(path, headers={"X-Content-Type-Options": "nosniff"})

    app.add_api_route(
        "/workspace-api/workspaces/{workspace_id}/files/{relative_path:path}",
        workspace_file_response,
        methods=["GET", "HEAD"],
    )

    app.mount("/mcp", protected_mcp)
    app.websocket("/bridge")(_bridge_endpoint)
    app.api_route("/", methods=HTTP_METHODS)(_proxy_request)
    app.api_route("/{path:path}", methods=HTTP_METHODS)(_proxy_request)
    return app


def start_background_server(listen_host: str, listen_port: int, gateway_base_url: str, api_key: str) -> None:
    app = create_relay_app(gateway_base_url, api_key)
    config = uvicorn.Config(app, host=listen_host, port=listen_port, log_level="info")
    server = uvicorn.Server(config)
    errors: list[BaseException] = []

    def runner() -> None:
        try:
            server.run()
        except BaseException as exc:
            errors.append(exc)

    import threading

    thread = threading.Thread(target=runner, daemon=True, name="hermes-relay")
    thread.start()

    deadline = time.time() + 10
    while time.time() < deadline:
        if errors:
            raise RuntimeError("relay failed to start") from errors[0]
        if server.started:
            return
        time.sleep(0.05)
    raise RuntimeError("relay did not report ready within 10s")
