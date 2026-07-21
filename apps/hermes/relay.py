"""Relay server for remote Hermes deployments.

When enabled, the relay fronts the public Hermes API, proxies requests to the
internal gateway, and tunnels MCP HTTP traffic over a reverse bridge connection
from uvicorn.
"""

import asyncio
import base64
import json
import os
import re
import shlex
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import unquote

import httpx
import uvicorn
import yaml
from fastapi import FastAPI, HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
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
MCP_SERVER_NAME = "silverretort-ui"
REMOTE_MCP_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
REMOTE_MCP_MARKER = "silverretortRemoteBridge"

import workspaces


def _strip_base_url(raw_url: str) -> str:
    return raw_url.rstrip("/")


def _bearer_token(headers: Any) -> str:
    header = headers.get("authorization", "")
    prefix = "bearer "
    if header.lower().startswith(prefix):
        return header[len(prefix) :].strip()
    return ""


def _filter_headers(headers: httpx.Headers | dict[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }


def _authorized_request(request: Request, api_key: str) -> bool:
    if not api_key.strip():
        return True
    if request.client and request.client.host.lower() in LOOPBACK_HOSTS:
        return True
    return _bearer_token(request.headers) == api_key.strip()


class BridgeSession:
    def __init__(self, websocket: WebSocket, relay_base_url: str) -> None:
        self.websocket = websocket
        self.relay_base_url = relay_base_url.rstrip("/")
        self._closed = asyncio.Event()
        self._http_streams: dict[str, tuple[asyncio.Future[dict[str, Any]], asyncio.Queue[Any]]] = {}
        self._stdio_requests: dict[str, asyncio.Future[dict[str, Any] | None]] = {}
        self.server_transports: dict[str, str] = {}
        self._send_lock = asyncio.Lock()

    async def run(self) -> None:
        error: Exception | None = None
        try:
            while True:
                payload = await self.websocket.receive_json()
                if not isinstance(payload, dict):
                    continue
                if await self._handle_control_payload(payload):
                    continue
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
        for future, queue in list(self._http_streams.values()):
            if not future.done():
                future.set_exception(error)
            queue.put_nowait(error)
        self._http_streams.clear()
        for future in self._stdio_requests.values():
            if not future.done():
                future.set_exception(error)
        self._stdio_requests.clear()

    async def stream_http_request(
        self,
        server_name: str,
        method: str,
        path: str,
        query: str,
        headers: dict[str, str],
        body: bytes,
    ) -> tuple[int, dict[str, str], Any]:
        if self._closed.is_set():
            raise RuntimeError("bridge disconnected")

        request_id = uuid.uuid4().hex
        start = asyncio.get_running_loop().create_future()
        queue: asyncio.Queue[Any] = asyncio.Queue()
        self._http_streams[request_id] = (start, queue)
        try:
            async with self._send_lock:
                await self.websocket.send_json(
                    {
                        "kind": "mcp_http_request",
                        "id": request_id,
                        "server": server_name,
                        "method": method,
                        "path": path,
                        "query": query,
                        "headers": headers,
                        "body": base64.b64encode(body).decode("ascii") if body else "",
                    }
                )
            started = await asyncio.wait_for(start, timeout=TOOL_TIMEOUT_SECONDS)
            return int(started["status"]), dict(started.get("headers") or {}), self._stream_http_chunks(request_id, queue)
        except Exception:
            self._http_streams.pop(request_id, None)
            raise

    async def stdio_request(
        self, server_name: str, message: dict[str, Any]
    ) -> dict[str, Any] | None:
        if self._closed.is_set():
            raise RuntimeError("bridge disconnected")
        request_id = uuid.uuid4().hex
        future: asyncio.Future[dict[str, Any] | None] = asyncio.get_running_loop().create_future()
        self._stdio_requests[request_id] = future
        try:
            async with self._send_lock:
                await self.websocket.send_json({
                    "kind": "mcp_stdio_request",
                    "id": request_id,
                    "server": server_name,
                    "message": message,
                })
            return await asyncio.wait_for(future, timeout=TOOL_TIMEOUT_SECONDS)
        finally:
            self._stdio_requests.pop(request_id, None)

    async def _stream_http_chunks(self, request_id: str, queue: asyncio.Queue[Any]) -> Any:
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            self._http_streams.pop(request_id, None)

    async def _handle_control_payload(self, payload: dict[str, Any]) -> bool:
        kind = payload.get("kind")
        if kind == "mcp_servers":
            servers = payload.get("servers")
            names = []
            if isinstance(servers, list):
                for item in servers:
                    raw_name = item.get("name") if isinstance(item, dict) else item
                    name = str(raw_name or "").strip()
                    if REMOTE_MCP_NAME_RE.fullmatch(name) and name != MCP_SERVER_NAME:
                        names.append(name)
                        transport = item.get("transport") if isinstance(item, dict) else None
                        self.server_transports[name] = (
                            "stdio" if transport == "stdio" else "streamable_http"
                        )
            self.server_transports = {
                name: self.server_transports.get(name, "streamable_http") for name in names
            }
            await _sync_remote_mcp_servers(sorted(set(names)), self.relay_base_url)
            return True

        request_id = str(payload.get("id") or "")
        stdio_future = self._stdio_requests.get(request_id)
        if stdio_future is not None:
            if kind == "mcp_stdio_response" and not stdio_future.done():
                message = payload.get("message")
                stdio_future.set_result(message if isinstance(message, dict) else None)
                return True
            if kind == "mcp_stdio_response_error" and not stdio_future.done():
                stdio_future.set_exception(
                    RuntimeError(str(payload.get("error") or "stdio MCP request failed"))
                )
                return True

        stream = self._http_streams.get(request_id)
        if stream is None:
            return False
        start, queue = stream
        if kind == "mcp_http_response_start":
            if not start.done():
                start.set_result(
                    {
                        "status": int(payload.get("status") or 502),
                        "headers": payload.get("headers") if isinstance(payload.get("headers"), dict) else {},
                    }
                )
            return True
        if kind == "mcp_http_response_chunk":
            try:
                chunk = base64.b64decode(str(payload.get("body") or ""))
            except ValueError:
                chunk = b""
            await queue.put(chunk)
            return True
        if kind == "mcp_http_response_end":
            await queue.put(None)
            return True
        if kind == "mcp_http_response_error":
            error = RuntimeError(str(payload.get("error") or "MCP proxy request failed"))
            if not start.done():
                start.set_exception(error)
            await queue.put(error)
            return True
        return False


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

    async def stream_http_request(
        self,
        server_name: str,
        method: str,
        path: str,
        query: str,
        headers: dict[str, str],
        body: bytes,
    ) -> tuple[int, dict[str, str], Any]:
        async with self._lock:
            session = self._active
        if session is None:
            raise RuntimeError("bridge unavailable")
        return await session.stream_http_request(server_name, method, path, query, headers, body)

    async def transport(self, server_name: str) -> str:
        async with self._lock:
            session = self._active
        if session is None:
            raise RuntimeError("bridge unavailable")
        return session.server_transports.get(server_name, "streamable_http")

    async def stdio_request(
        self, server_name: str, message: dict[str, Any]
    ) -> dict[str, Any] | None:
        async with self._lock:
            session = self._active
        if session is None:
            raise RuntimeError("bridge unavailable")
        return await session.stdio_request(server_name, message)


class RelayState:
    def __init__(self, bridge: BridgeRegistry, gateway_base_url: str, relay_base_url: str) -> None:
        self.bridge = bridge
        self.gateway_base_url = _strip_base_url(gateway_base_url)
        self.relay_base_url = _strip_base_url(relay_base_url)
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10))


def _hermes_config_path() -> str:
    home = os.getenv("HERMES_HOME", "").strip()
    if not home:
        home = str(os.path.join(os.path.dirname(__file__), "home"))
    os.makedirs(home, exist_ok=True)
    return os.path.join(home, "config.yaml")


def _sync_remote_mcp_servers_sync(server_names: list[str], relay_base_url: str) -> None:
    config_path = _hermes_config_path()
    config: dict[str, Any] = {}
    if os.path.exists(config_path):
        with open(config_path, encoding="utf-8") as input_file:
            config = yaml.safe_load(input_file) or {}
    servers = config.setdefault("mcp_servers", {})
    if not isinstance(servers, dict):
        servers = {}
        config["mcp_servers"] = servers

    for name, entry in list(servers.items()):
        if isinstance(entry, dict) and entry.get(REMOTE_MCP_MARKER):
            servers.pop(name, None)

    for name in server_names:
        servers[name] = {
            "url": f"{relay_base_url}/mcp/{name}/",
            "transport": "streamable_http",
            "enabled": True,
            REMOTE_MCP_MARKER: True,
        }

    with open(config_path, "w", encoding="utf-8") as output:
        yaml.safe_dump(config, output, allow_unicode=True, sort_keys=False)


async def _reload_hermes_mcp() -> None:
    def reload_now() -> None:
        try:
            from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers

            shutdown_mcp_servers()
            discover_mcp_tools()
        except Exception:
            return

    await asyncio.to_thread(reload_now)


async def _sync_remote_mcp_servers(server_names: list[str], relay_base_url: str) -> None:
    await asyncio.to_thread(_sync_remote_mcp_servers_sync, server_names, relay_base_url)
    asyncio.create_task(_reload_hermes_mcp())


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
                cd_command = f"cd {shlex.quote(str(workspace_path))}"
                suffix = (
                    f"\nHermes workspace root: {workspace_path}. "
                    f"At the start of this agent run, before inspecting files or running any other command, run `{cd_command}`. "
                    "Every delegated or sub-agent must run the same command as its first shell command. "
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
    session = BridgeSession(websocket, state.relay_base_url)
    await state.bridge.attach(session)
    try:
        await session.run()
    finally:
        await state.bridge.detach(session)


async def _mcp_proxy_request(server_name: str, request: Request, path: str = "") -> Response:
    if not _authorized_request(request, request.app.state.bridge_api_key):
        return PlainTextResponse("unauthorized", status_code=401)
    if not REMOTE_MCP_NAME_RE.fullmatch(server_name):
        raise HTTPException(404, "MCP server not found")
    state: RelayState = request.app.state.relay_state
    try:
        if await state.bridge.transport(server_name) == "stdio":
            if request.method != "POST":
                return Response(status_code=405, headers={"Allow": "POST"})
            try:
                message = await request.json()
            except json.JSONDecodeError as exc:
                raise HTTPException(400, "invalid MCP JSON-RPC body") from exc
            if not isinstance(message, dict):
                raise HTTPException(400, "MCP JSON-RPC body must be an object")
            response = await state.bridge.stdio_request(server_name, message)
            if response is None:
                return Response(status_code=202)
            return JSONResponse(response)
        status, headers, stream = await state.bridge.stream_http_request(
            server_name,
            request.method,
            path,
            request.url.query,
            _filter_headers(dict(request.headers.items())),
            await request.body(),
        )
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    return StreamingResponse(stream, status_code=status, headers=_filter_headers(headers))


async def _builtin_mcp_proxy_request(request: Request) -> Response:
    return await _mcp_proxy_request(MCP_SERVER_NAME, request, "")


def create_relay_app(gateway_base_url: str, api_key: str, relay_base_url: str) -> FastAPI:
    bridge = BridgeRegistry()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.bridge_api_key = api_key.strip()
        app.state.relay_state = RelayState(bridge, gateway_base_url, relay_base_url)
        try:
            yield
        finally:
            await app.state.relay_state.http.aclose()

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def protect_workspace_api(request: Request, call_next: Any):
        if (
            request.url.path.startswith("/workspace-api")
            or request.url.path.startswith("/workspace-proxy")
            or request.url.path.startswith("/silverretort/")
        ):
            client_host = request.client.host.lower() if request.client else ""
            if api_key.strip() and client_host not in LOOPBACK_HOSTS and _bearer_token(request.headers) != api_key.strip():
                return PlainTextResponse("unauthorized", status_code=401)
        return await call_next(request)

    from silverretort_api import register_silverretort_routes
    register_silverretort_routes(app, api_key)

    @app.get("/workspace-api/capability")
    async def workspace_capability() -> dict[str, Any]:
        root = workspaces.root_dir()
        return {
            "supported": True,
            "version": 2,
            "writable": os.access(root, os.W_OK),
            "cwdEnforced": False,
            "workspaceProxy": {
                "supported": True,
                "version": 1,
                "http": True,
                "websocket": True,
                "pathPrefixRequired": True,
            },
        }

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

    app.api_route("/mcp", methods=HTTP_METHODS)(_builtin_mcp_proxy_request)
    app.api_route("/mcp/", methods=HTTP_METHODS)(_builtin_mcp_proxy_request)
    app.api_route("/mcp/{server_name}", methods=HTTP_METHODS)(_mcp_proxy_request)
    app.api_route("/mcp/{server_name}/{path:path}", methods=HTTP_METHODS)(_mcp_proxy_request)
    app.websocket("/bridge")(_bridge_endpoint)
    from workspace_proxy import register_workspace_proxy_routes
    register_workspace_proxy_routes(app, HTTP_METHODS)
    app.api_route("/", methods=HTTP_METHODS)(_proxy_request)
    app.api_route("/{path:path}", methods=HTTP_METHODS)(_proxy_request)
    return app


def start_background_server(listen_host: str, listen_port: int, gateway_base_url: str, api_key: str) -> None:
    app = create_relay_app(gateway_base_url, api_key, f"http://127.0.0.1:{listen_port}")
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
