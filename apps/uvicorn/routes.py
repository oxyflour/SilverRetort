"""REST API + 常驻事件通道。路径与 packages/protocol 的 ApiClient 一一对应。"""

import asyncio
import json
import mimetypes
import os
import re
import threading
from contextlib import suppress
from pathlib import Path, PurePosixPath
import uuid
from urllib.parse import quote, unquote, urlparse
from urllib.request import url2pathname

import httpx
from fastapi import APIRouter, Body, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from sse_starlette.sse import EventSourceResponse
from websockets.asyncio.client import connect

import db
import artifact_contexts
import events
import mcp_server
import runs
import workspace_service
from engines import create_engine
from models import (
    ApiModel,
    Artifact,
    ArtifactContext,
    ArtifactContextUpdateRequest,
    Attachment,
    CreateWorkspaceRequest,
    CreateSessionRequest,
    Message,
    ModelSetting,
    RestartMessageRequest,
    SendChatRequest,
    SendChatResponse,
    SetModelRequest,
    Session,
    SessionModel,
    SlashCommand,
    TextPart,
    ToolCall,
    UpdateSessionRequest,
    UpdateWorkspaceRequest,
    Workspace,
    WorkspaceCapability,
    HermesModel,
    HermesModelsResponse,
    HermesUsageResponse,
)

router = APIRouter(prefix="/api")
engine = create_engine()
MCP_SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MCP_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
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

DEFAULT_TITLE = "新会话"


def _data_dir() -> Path:
    path = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _desktop_settings_path() -> Path:
    return _data_dir() / "settings.json"


def _read_desktop_settings() -> dict:
    path = _desktop_settings_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_desktop_settings(settings: dict) -> None:
    _desktop_settings_path().write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", "utf-8")


def _mcp_server_response(settings: dict) -> dict:
    raw_servers = settings.get("mcpServers")
    if not isinstance(raw_servers, dict):
        return {"servers": []}
    servers = []
    for name, raw_config in sorted(raw_servers.items()):
        if not MCP_SERVER_NAME_RE.fullmatch(str(name)):
            continue
        config = raw_config if isinstance(raw_config, dict) else {}
        raw_headers = config.get("headers") if isinstance(config.get("headers"), dict) else {}
        servers.append({
            "name": str(name),
            "url": str(config.get("url") or ""),
            "headers": {str(key): str(value) for key, value in raw_headers.items()},
            "enabled": config.get("enabled") is not False,
        })
    return {"servers": servers}


def _validate_mcp_url(url: str) -> str:
    value = url.strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "MCP URL must be http(s)")
    if parsed.hostname.lower() not in MCP_LOOPBACK_HOSTS:
        raise HTTPException(400, "MCP URL must point to loopback")
    return value


def _mcp_servers_from_body(body: dict) -> dict:
    raw_servers = body.get("servers")
    if not isinstance(raw_servers, list):
        raise HTTPException(400, "servers must be a list")
    servers = {}
    for raw_item in raw_servers:
        item = raw_item if isinstance(raw_item, dict) else {}
        name = str(item.get("name") or "").strip()
        if name == "silverretort-ui":
            raise HTTPException(400, "silverretort-ui is reserved")
        if not MCP_SERVER_NAME_RE.fullmatch(name):
            raise HTTPException(400, f"invalid MCP server name: {name}")
        if name in servers:
            raise HTTPException(400, f"duplicate MCP server name: {name}")
        raw_headers = item.get("headers") if isinstance(item.get("headers"), dict) else {}
        headers = {
            str(key).strip(): str(value)
            for key, value in raw_headers.items()
            if str(key).strip()
        }
        servers[name] = {
            "url": _validate_mcp_url(str(item.get("url") or "")),
            "headers": headers,
            "enabled": item.get("enabled") is not False,
        }
    return servers


def _hermes_connection_response() -> dict:
    settings = _read_desktop_settings()
    configured_url = str(settings.get("switchUrl") or "")
    runtime_mode = os.getenv("SILVERRETORT_HERMES_MODE")
    switch_url = configured_url or (str(os.getenv("HERMES_URL") or "") if runtime_mode == "remote" else "")
    local_hermes_enabled = os.getenv("SILVERRETORT_DESKTOP_MODE") != "packaged" or bool(str(os.getenv("ENABLE_LOCAL_HERMES") or "").strip())
    return {
        "packaged": os.getenv("SILVERRETORT_DESKTOP_MODE") == "packaged",
        "mode": "remote" if configured_url or runtime_mode in {"remote", "disabled"} else "local",
        "switchUrl": switch_url,
        "hasHermesApiKey": bool(settings.get("hermesApiKey") or (runtime_mode == "remote" and os.getenv("HERMES_API_KEY"))),
        "localHermesEnabled": local_hermes_enabled,
        "restartRequired": False,
    }


def _auto_title(text: str) -> str:
    return text[:30] or DEFAULT_TITLE


def _require_hermes_method(name: str):
    method = getattr(engine, name, None)
    if method is None:
        raise HTTPException(503, "Hermes is unavailable")
    return method


def _models_response(payload: dict) -> HermesModelsResponse:
    default = payload.get("default") if isinstance(payload.get("default"), dict) else {}
    return HermesModelsResponse(
        models=[HermesModel.model_validate(item) for item in payload.get("models", [])],
        default_provider=str(default.get("provider") or ""),
        default_model=str(default.get("model") or ""),
    )



@router.get("/hermes/connection")
def hermes_connection() -> dict:
    return _hermes_connection_response()


@router.put("/hermes/connection")
def set_hermes_connection(body: dict = Body(...)) -> dict:
    mode = str(body.get("mode") or "").strip().lower()
    settings = _read_desktop_settings()
    if mode == "remote":
        switch_url = str(body.get("switchUrl") or "").strip().rstrip("/")
        if not switch_url:
            raise HTTPException(400, "switchUrl is required")
        settings["switchUrl"] = switch_url
        settings.pop("hermesUrl", None)
        hermes_api_key = str(body.get("hermesApiKey") or "").strip()
        if hermes_api_key:
            settings["hermesApiKey"] = hermes_api_key
        elif not settings.get("hermesApiKey"):
            raise HTTPException(400, "hermesApiKey is required")
    elif mode == "local":
        settings.pop("switchUrl", None)
        settings.pop("hermesApiKey", None)
    else:
        raise HTTPException(400, "mode must be local or remote")
    _write_desktop_settings(settings)
    response = _hermes_connection_response()
    response["restartRequired"] = True
    return response


@router.get("/hermes/mcp-servers")
def hermes_mcp_servers() -> dict:
    return _mcp_server_response(_read_desktop_settings())


@router.put("/hermes/mcp-servers")
def set_hermes_mcp_servers(body: dict = Body(...)) -> dict:
    settings = _read_desktop_settings()
    servers = _mcp_servers_from_body(body)
    if servers:
        settings["mcpServers"] = servers
    else:
        settings.pop("mcpServers", None)
    _write_desktop_settings(settings)
    return _mcp_server_response(settings)



@router.post("/app/restart")
def restart_app() -> dict:
    def exit_soon() -> None:
        os._exit(42)

    threading.Timer(0.2, exit_soon).start()
    return {"ok": True}


# ---- sessions ----

@router.get("/sessions")
def list_sessions() -> list[Session]:
    return db.list_sessions()


@router.get("/workspaces/capability")
async def workspace_capability() -> WorkspaceCapability:
    return WorkspaceCapability.model_validate(await workspace_service.capability())


@router.get("/hermes/slash-commands")
async def hermes_slash_commands() -> list[SlashCommand]:
    method = _require_hermes_method("list_slash_commands")
    try:
        return [SlashCommand.model_validate(item) for item in await method()]
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return []
        raise HTTPException(503, f"Hermes slash commands unavailable: {exc}") from exc
    except Exception as exc:
        raise HTTPException(503, f"Hermes slash commands unavailable: {exc}") from exc


@router.get("/hermes/models")
async def hermes_models() -> HermesModelsResponse:
    method = _require_hermes_method("list_models")
    try:
        return _models_response(await method())
    except Exception as exc:
        raise HTTPException(503, f"Hermes models unavailable: {exc}") from exc


@router.get("/hermes/usage")
async def hermes_usage(sessionId: str | None = None) -> HermesUsageResponse:
    method = _require_hermes_method("get_usage")
    try:
        return HermesUsageResponse.model_validate(await method(sessionId))
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return HermesUsageResponse(unavailable_reason="Hermes usage endpoint unavailable")
        raise HTTPException(503, f"Hermes usage unavailable: {exc}") from exc
    except Exception as exc:
        raise HTTPException(503, f"Hermes usage unavailable: {exc}") from exc


@router.get("/hermes/default-model")
async def hermes_default_model() -> SessionModel:
    method = _require_hermes_method("get_default_model")
    try:
        payload = await method()
        provider = str(payload.get("provider") or "")
        model = str(payload.get("model") or "")
        return SessionModel(
            source="default",
            provider=provider,
            model=model,
            model_id=str(payload.get("modelId") or ""),
            default_provider=provider,
            default_model=model,
            base_url=str(payload.get("baseUrl") or ""),
            has_api_key=bool(payload.get("hasApiKey")),
        )
    except Exception as exc:
        raise HTTPException(503, f"Hermes default model unavailable: {exc}") from exc


@router.put("/hermes/default-model")
async def set_hermes_default_model(body: SetModelRequest) -> SessionModel:
    if not body.provider or not body.model:
        raise HTTPException(400, "provider and model are required")
    method = _require_hermes_method("set_default_model")
    try:
        payload = await method(
            body.provider,
            body.model,
            body.model_id,
            body.base_url,
            body.api_key,
        )
        provider = str(payload.get("provider") or body.provider)
        model = str(payload.get("model") or body.model)
        return SessionModel(
            source="default",
            provider=provider,
            model=model,
            model_id=str(payload.get("modelId") or body.model_id or ""),
            default_provider=provider,
            default_model=model,
            base_url=str(payload.get("baseUrl") or ""),
            has_api_key=bool(payload.get("hasApiKey")),
        )
    except Exception as exc:
        raise HTTPException(503, f"failed to set Hermes default model: {exc}") from exc


@router.get("/hermes/vision-model")
async def hermes_vision_model() -> ModelSetting:
    method = _require_hermes_method("get_vision_model")
    try:
        return ModelSetting.model_validate(await method())
    except Exception as exc:
        raise HTTPException(503, f"Hermes vision model unavailable: {exc}") from exc


@router.put("/hermes/vision-model")
async def set_hermes_vision_model(body: SetModelRequest) -> ModelSetting:
    has_provider = bool(body.provider and body.provider.strip())
    has_model = bool(body.model and body.model.strip())
    if has_provider != has_model:
        raise HTTPException(400, "provider and model must both be set or both be empty")
    method = _require_hermes_method("set_vision_model")
    try:
        payload = await method(
            body.provider,
            body.model,
            body.model_id,
            body.base_url,
            body.api_key,
        )
        return ModelSetting.model_validate(payload)
    except Exception as exc:
        raise HTTPException(503, f"failed to set Hermes vision model: {exc}") from exc


@router.get("/workspaces")
async def list_workspaces() -> list[Workspace]:
    workspaces = db.list_workspaces()
    capability = await workspace_service.capability()
    if capability.get("supported") and capability.get("writable"):
        for workspace in workspaces:
            try:
                await workspace_service.create_remote(workspace.id)
                db.set_workspace_status(workspace.id, "active")
            except Exception:
                db.set_workspace_status(workspace.id, "error")
        workspaces = db.list_workspaces()
    return workspaces


@router.post("/workspaces")
async def create_workspace(body: CreateWorkspaceRequest) -> Workspace:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "workspace name is required")
    workspace_id = uuid.uuid4().hex
    try:
        await workspace_service.create_remote(workspace_id)
    except Exception as exc:
        raise HTTPException(503, f"Hermes workspace unavailable: {exc}") from exc
    try:
        return db.create_workspace(workspace_id, name)
    except Exception:
        await workspace_service.delete_remote(workspace_id)
        raise


@router.patch("/workspaces/{workspace_id}")
def rename_workspace(workspace_id: str, body: UpdateWorkspaceRequest) -> Workspace:
    workspace = db.rename_workspace(workspace_id, body.name.strip())
    if workspace is None:
        raise HTTPException(404, "workspace not found")
    return workspace


@router.delete("/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str) -> dict[str, bool]:
    if db.get_workspace(workspace_id) is None:
        raise HTTPException(404, "workspace not found")
    for session in db.list_sessions():
        if session.workspace_id == workspace_id:
            runs.stop_run(session.id)
    db.set_workspace_status(workspace_id, "deleting")
    try:
        await workspace_service.delete_remote(workspace_id)
    except Exception as exc:
        db.set_workspace_status(workspace_id, "error")
        raise HTTPException(503, f"failed to delete Hermes workspace: {exc}") from exc
    db.delete_workspace(workspace_id)
    if not db.list_workspaces():
        fallback_id = uuid.uuid4().hex
        await workspace_service.create_remote(fallback_id)
        db.create_workspace(fallback_id, "默认工作区")
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/sessions")
def create_session(workspace_id: str, body: CreateSessionRequest) -> Session:
    workspace = db.get_workspace(workspace_id)
    if workspace is None or workspace.status != "active":
        raise HTTPException(409, "workspace is unavailable")
    return db.create_session(uuid.uuid4().hex, workspace_id, body.title or DEFAULT_TITLE)


@router.patch("/sessions/{session_id}")
def rename_session(session_id: str, body: UpdateSessionRequest) -> Session:
    session = db.rename_session(session_id, body.title)
    if session is None:
        raise HTTPException(404, "session not found")
    return session


@router.get("/sessions/{session_id}/model")
async def get_session_model(session_id: str) -> SessionModel:
    if db.get_session(session_id) is None:
        raise HTTPException(404, "session not found")
    method = _require_hermes_method("get_session_model")
    try:
        return SessionModel.model_validate(await method(session_id))
    except Exception as exc:
        raise HTTPException(503, f"Hermes session model unavailable: {exc}") from exc


@router.put("/sessions/{session_id}/model")
async def set_session_model(session_id: str, body: SetModelRequest) -> SessionModel:
    if db.get_session(session_id) is None:
        raise HTTPException(404, "session not found")
    method = _require_hermes_method("set_session_model")
    try:
        return SessionModel.model_validate(
            await method(session_id, body.provider, body.model, body.model_id)
        )
    except Exception as exc:
        raise HTTPException(503, f"failed to set Hermes session model: {exc}") from exc


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    runs.stop_run(session_id)
    db.delete_session(session_id)
    return {"ok": True}


TOOL_SUMMARY_LIMIT = 240


def _compact_message(message: Message) -> Message:
    compact_message = message.model_copy(deep=True)
    for part in compact_message.parts:
        if getattr(part, "type", None) != "tool":
            continue
        tool_call = part.tool_call
        if tool_call.detail and len(tool_call.detail) > TOOL_SUMMARY_LIMIT:
            tool_call.detail = tool_call.detail[:TOOL_SUMMARY_LIMIT] + "…"
            tool_call.detail_truncated = True
        if tool_call.result and len(tool_call.result) > TOOL_SUMMARY_LIMIT:
            tool_call.result = tool_call.result[:TOOL_SUMMARY_LIMIT] + "…"
            tool_call.result_truncated = True
    return compact_message


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str, compact: bool = False) -> list[Message]:
    messages = db.list_messages(session_id)
    return [_compact_message(message) for message in messages] if compact else messages


@router.get("/sessions/{session_id}/messages/{message_id}/tools/{tool_call_id}")
def get_message_tool(
    session_id: str, message_id: str, tool_call_id: str
) -> ToolCall:
    message = db.get_message(session_id, message_id)
    if message is None:
        raise HTTPException(404, "message not found")
    for part in message.parts:
        if getattr(part, "type", None) == "tool" and part.tool_call.id == tool_call_id:
            return part.tool_call
    raise HTTPException(404, "tool call not found")


@router.get("/sessions/{session_id}/artifacts")
def list_artifacts(session_id: str) -> list[Artifact]:
    return db.list_artifacts(session_id)


@router.get("/artifacts/{artifact_id}")
def get_artifact(artifact_id: str) -> Artifact:
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, "artifact not found")
    return artifact


@router.get("/sessions/{session_id}/artifact-contexts")
def list_artifact_contexts(session_id: str) -> list[ArtifactContext]:
    if db.get_session(session_id) is None:
        raise HTTPException(404, "session not found")
    return db.list_pending_artifact_contexts(session_id)


@router.put("/artifacts/{artifact_id}/context")
async def set_artifact_context(
    artifact_id: str,
    body: ArtifactContextUpdateRequest,
    request: Request,
) -> ArtifactContext:
    if request.headers.get("x-silverretort-artifact-bridge") != "1":
        raise HTTPException(403, "artifact bridge header is required")
    return artifact_contexts.set_context(artifact_id, body)


@router.delete("/artifacts/{artifact_id}/context")
async def clear_artifact_context(artifact_id: str, request: Request) -> dict[str, bool]:
    if request.headers.get("x-silverretort-artifact-bridge") != "1":
        raise HTTPException(403, "artifact bridge header is required")
    artifact_contexts.clear_context(artifact_id)
    return {"ok": True}


async def _workspace_file_response(
    workspace_id: str,
    relative_path: str,
    *,
    download_name: str | None = None,
    no_cache: bool = False,
):
    try:
        metadata = await workspace_service.stat_workspace_file(workspace_id, relative_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "file not found") from exc
    headers = {"X-Content-Type-Options": "nosniff"}
    if no_cache:
        headers.update(_artifact_content_headers())
        headers["Content-Security-Policy"] = (
            "default-src 'self' data: blob:; "
            "script-src 'self' 'unsafe-inline' http: https: blob:; "
            "style-src 'self' 'unsafe-inline' http: https:; "
            "img-src 'self' data: blob: http: https:; "
            "font-src 'self' data: http: https:; "
            "media-src 'self' data: blob: http: https:; "
            "connect-src 'self' http: https: ws: wss:; "
            "worker-src 'self' blob:; "
            "form-action 'none'; object-src 'none'; "
            "base-uri 'none'; frame-src http: https:"
        )
    if download_name:
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(Path(download_name).name)}"
    local_path = workspace_service.local_file_path(workspace_id, relative_path)
    if local_path is not None:
        return FileResponse(local_path, media_type=metadata["mimeType"], headers=headers)
    try:
        client, response = await workspace_service.open_remote_file(workspace_id, relative_path)
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"workspace file service unavailable: {exc}") from exc
    if response.status_code == 404:
        await response.aclose(); await client.aclose()
        raise HTTPException(404, "file not found")
    if response.status_code != 200:
        status = response.status_code
        await response.aclose(); await client.aclose()
        raise HTTPException(503, f"workspace file service returned {status}")
    async def stream():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose(); await client.aclose()
    headers["Content-Length"] = str(metadata["size"])
    return StreamingResponse(stream(), media_type=metadata["mimeType"], headers=headers)


def _artifact_content_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Private-Network": "true",
        "Cross-Origin-Resource-Policy": "cross-origin",
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
        await workspace_service.require_workspace_proxy()
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10))
    upstream = client.build_request(
        request.method,
        workspace_service.remote_workspace_proxy_url(workspace_id, port, path, request.url.query),
        headers=_remote_auth_headers(request.headers),
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
        await workspace_service.require_workspace_proxy()
    except (HTTPException, RuntimeError) as exc:
        reason = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        await websocket.close(code=1013, reason=reason)
        return

    await websocket.accept()
    try:
        async with connect(
            workspace_service.remote_workspace_proxy_ws_url(workspace_id, port, path, websocket.url.query),
            additional_headers=_remote_auth_headers(),
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


@router.options("/artifacts/{artifact_id}/content")
@router.options("/artifacts/{artifact_id}/content/")
@router.options("/artifacts/{artifact_id}/content/{asset_path:path}")
async def options_artifact_content(artifact_id: str, asset_path: str | None = None):
    return Response(status_code=204, headers=_artifact_content_headers())


def _workspace_port_payload_target(payload: dict, asset_path: str | None = None) -> tuple[int, str]:
    config = payload.get("workspacePort")
    if not isinstance(config, dict):
        raise HTTPException(400, "iframe artifact requires payload.workspacePort")
    port = config.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or port < 1 or port > 65535:
        raise HTTPException(400, "iframe workspacePort.port must be an integer from 1 to 65535")
    raw_path = config.get("path")
    if raw_path is not None and not isinstance(raw_path, str):
        raise HTTPException(400, "iframe workspacePort.path must be a string")
    entry = (raw_path or "").strip("/")
    if not asset_path:
        return port, entry
    if entry.endswith("/"):
        return port, (PurePosixPath(entry) / asset_path).as_posix()
    return port, (PurePosixPath(entry).parent / asset_path).as_posix() if entry else asset_path


@router.get("/artifacts/{artifact_id}/content")
@router.get("/artifacts/{artifact_id}/content/")
@router.get("/artifacts/{artifact_id}/content/{asset_path:path}")
async def get_artifact_content(artifact_id: str, asset_path: str | None = None):
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, "artifact not found")
    if artifact.type != "iframe":
        raise HTTPException(400, "artifact is not an iframe")
    payload = artifact.payload
    if not isinstance(payload, dict):
        raise HTTPException(400, "iframe artifact requires payload")
    session = db.get_session(artifact.session_id)
    if session is None:
        raise HTTPException(404, "artifact session not found")
    if "workspacePort" in payload:
        try:
            await workspace_service.require_workspace_proxy()
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        port, path = _workspace_port_payload_target(payload, asset_path)
        return RedirectResponse(workspace_service.local_workspace_proxy_url(session.workspace_id, port, path), status_code=307)
    if not isinstance(payload.get("path"), str):
        raise HTTPException(400, "iframe artifact requires payload.path")
    try:
        relative_path = workspace_service.resolve_artifact_asset(payload["path"], asset_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return await _workspace_file_response(session.workspace_id, relative_path, no_cache=True)


# ---- chat run ----

@router.post("/sessions/{session_id}/chat")
async def send_chat(session_id: str, body: SendChatRequest) -> SendChatResponse:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    if runs.is_running(session_id):
        raise HTTPException(409, "session already has an active run")

    attachments = []
    for requested in body.attachments:
        if requested.workspace_id != session.workspace_id:
            raise HTTPException(400, "attachment belongs to another workspace")
        try:
            metadata = await workspace_service.stat_workspace_file(session.workspace_id, requested.relative_path)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(400, f"attachment not found: {requested.relative_path}") from exc
        attachments.append(Attachment.model_validate(metadata))

    history = db.list_messages(session_id)
    now = db.now_iso()
    user_message = Message(
        id=uuid.uuid4().hex,
        session_id=session_id,
        role="user",
        parts=[TextPart(text=body.text)],
        attachments=attachments,
        created_at=now,
    )
    assistant_message = Message(
        id=uuid.uuid4().hex,
        session_id=session_id,
        role="assistant",
        status="streaming",
        created_at=now,
    )
    consumed_contexts = db.insert_message_with_pending_artifact_contexts(user_message)
    db.insert_message(assistant_message)
    events.broadcast(
        events.user_message(session_id, user_message.model_dump(by_alias=True))
    )
    for context in consumed_contexts:
        events.broadcast(events.artifact_context(session_id, context.artifact_id, None))

    # 首条消息时用内容生成标题
    if session.title == DEFAULT_TITLE and not history:
        db.rename_session(session_id, _auto_title(body.text))

    run_id = uuid.uuid4().hex
    runs.start_run(engine, session_id, session.workspace_id, run_id, history, user_message, assistant_message)
    return SendChatResponse(
        run_id=run_id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
    )


@router.post("/sessions/{session_id}/messages/{message_id}/restart")
async def restart_message(
    session_id: str, message_id: str, body: RestartMessageRequest
) -> SendChatResponse:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    if runs.is_running(session_id):
        raise HTTPException(409, "session already has an active run")

    try:
        result = db.restart_message(session_id, message_id, body.text)
    except db.MessageRestartNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except db.MessageRestartNotAllowedError as exc:
        raise HTTPException(400, str(exc)) from exc

    now = db.now_iso()
    assistant_message = Message(
        id=uuid.uuid4().hex,
        session_id=session_id,
        role="assistant",
        status="streaming",
        created_at=now,
    )
    db.insert_message(assistant_message)

    if result.was_first_user_message and session.title == _auto_title(result.old_text):
        db.rename_session(session_id, _auto_title(body.text))

    run_id = uuid.uuid4().hex
    runs.start_run(engine, session_id, session.workspace_id, run_id, result.history, result.user_message, assistant_message)
    return SendChatResponse(
        run_id=run_id,
        user_message_id=result.user_message.id,
        assistant_message_id=assistant_message.id,
    )


@router.post("/sessions/{session_id}/stop")
async def stop_run(session_id: str) -> dict[str, bool]:
    return {"ok": runs.stop_run(session_id)}


# ---- files ----

@router.post("/workspaces/{workspace_id}/files")
async def upload_file(workspace_id: str, file: UploadFile) -> Attachment:
    if db.get_workspace(workspace_id) is None:
        raise HTTPException(404, "workspace not found")
    try:
        result = await workspace_service.upload_file(workspace_id, file)
    except Exception as exc:
        raise HTTPException(503, f"file upload failed: {exc}") from exc
    return Attachment.model_validate(result)


@router.get("/workspaces/{workspace_id}/files")
async def list_workspace_files(workspace_id: str) -> list[Attachment]:
    if db.get_workspace(workspace_id) is None:
        raise HTTPException(404, "workspace not found")
    try:
        return [Attachment.model_validate(item) for item in await workspace_service.list_workspace_files(workspace_id)]
    except FileNotFoundError as exc:
        raise HTTPException(404, "workspace not found") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"workspace file service unavailable: {exc}") from exc


@router.get("/workspaces/{workspace_id}/files/content/{relative_path:path}")
async def get_file(workspace_id: str, relative_path: str):
    if db.get_workspace(workspace_id) is None:
        raise HTTPException(404, "workspace not found")
    return await _workspace_file_response(
        workspace_id, relative_path, download_name=PurePosixPath(relative_path).name
    )


def _resolve_local_image_path(raw_path: str) -> Path:
    if not raw_path:
        raise HTTPException(400, "path is required")
    if raw_path.startswith("file://"):
        parsed = urlparse(raw_path)
        path_str = url2pathname(unquote(parsed.path))
        if parsed.netloc and parsed.netloc != "localhost":
            path_str = f"//{parsed.netloc}{path_str}"
    else:
        path_str = raw_path
    path = Path(path_str).expanduser()
    if not path.is_absolute():
        path = path.resolve()
    return path


@router.get("/local-image")
def get_local_image(path: str) -> FileResponse:
    resolved = _resolve_local_image_path(path)
    if not resolved.is_file():
        raise HTTPException(404, "local image not found")
    mime_type, _ = mimetypes.guess_type(resolved.name)
    if mime_type is None or not mime_type.startswith("image/"):
        raise HTTPException(400, "local path is not an image")
    return FileResponse(resolved, media_type=mime_type, filename=resolved.name)


# ---- events ----

@router.get("/events")
async def event_stream() -> EventSourceResponse:
    return EventSourceResponse(events.subscribe())


# ---- ui capability report ----

class RenderTypesRequest(ApiModel):
    types: list[str] = []
    renderers: list[dict] = []


@router.post("/render-types")
def report_render_types(body: RenderTypesRequest) -> dict[str, bool]:
    if body.renderers:
        mcp_server.set_render_definitions(body.renderers)
    else:
        mcp_server.set_render_types(body.types)
    return {"ok": True}
