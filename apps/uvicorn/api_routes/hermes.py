"""Hermes connection, model, and switch profile routes."""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Body, HTTPException

import bridge_client
import db
import switch_profiles
from api_routes.common import _engine_from_context, _models_response, _require_engine_method
from models import (
    CreateSwitchProfileRequest,
    HermesModelsResponse,
    HermesRuntimeResponse,
    HermesUsageResponse,
    ModelSetting,
    SessionModel,
    SetModelRequest,
    SlashCommand,
    SwitchProfile,
    UpdateSwitchProfileRequest,
)

router = APIRouter()
MCP_SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MCP_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


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
        item = {
            "name": str(name),
            "transport": "stdio" if config.get("transport") == "stdio" else "streamable_http",
            "url": str(config.get("url") or ""),
            "headers": {str(key): str(value) for key, value in raw_headers.items()},
            "enabled": config.get("enabled") is not False,
            "command": str(config.get("command") or ""),
            "args": config.get("args") if isinstance(config.get("args"), list) else [],
            "env": config.get("env") if isinstance(config.get("env"), dict) else {},
            "cwd": str(config.get("cwd") or ""),
        }
        servers.append(item)
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
        transport = str(item.get("transport") or "streamable_http")
        if transport == "stdio":
            command = str(item.get("command") or "").strip()
            args = item.get("args")
            env = item.get("env")
            if not command:
                raise HTTPException(400, f"MCP server {name} command is required")
            if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
                raise HTTPException(400, f"MCP server {name} args must be a string array")
            if not isinstance(env, dict):
                raise HTTPException(400, f"MCP server {name} env must be an object")
            servers[name] = {
                "transport": "stdio",
                "command": command,
                "args": args,
                "env": {str(key): str(value) for key, value in env.items()},
                "cwd": str(item.get("cwd") or "").strip(),
                "enabled": item.get("enabled") is not False,
            }
            continue
        if transport != "streamable_http":
            raise HTTPException(400, f"unsupported MCP transport: {transport}")
        raw_headers = item.get("headers") if isinstance(item.get("headers"), dict) else {}
        servers[name] = {
            "transport": "streamable_http",
            "url": _validate_mcp_url(str(item.get("url") or "")),
            "headers": {
                str(key).strip(): str(value)
                for key, value in raw_headers.items()
                if str(key).strip()
            },
            "enabled": item.get("enabled") is not False,
        }
    return servers


def _hermes_connection_response() -> dict:
    runtime_mode = os.getenv("SILVERRETORT_HERMES_MODE")
    profile = switch_profiles.get_profile(switch_profiles.default_profile_id())
    switch_url = profile.switch_url if profile and profile.mode == "remote" else ""
    if not switch_url and runtime_mode == "remote":
        switch_url = str(os.getenv("HERMES_URL") or "")
    local_hermes_enabled = os.getenv("SILVERRETORT_DESKTOP_MODE") != "packaged" or bool(str(os.getenv("ENABLE_LOCAL_HERMES") or "").strip())
    return {
        "packaged": os.getenv("SILVERRETORT_DESKTOP_MODE") == "packaged",
        "mode": "remote" if switch_url or runtime_mode in {"remote", "disabled"} else "local",
        "switchUrl": switch_url,
        "hasHermesApiKey": bool((profile and profile.has_hermes_api_key) or (runtime_mode == "remote" and os.getenv("HERMES_API_KEY"))),
        "localHermesEnabled": local_hermes_enabled,
        "restartRequired": False,
    }

@router.get("/hermes/connection")
def hermes_connection() -> dict:
    return _hermes_connection_response()


@router.put("/hermes/connection")
def set_hermes_connection(body: dict = Body(...)) -> dict:
    mode = str(body.get("mode") or "").strip().lower()
    if mode == "remote":
        switch_url = str(body.get("switchUrl") or "").strip().rstrip("/")
        if not switch_url:
            raise HTTPException(400, "switchUrl is required")
        hermes_api_key = str(body.get("hermesApiKey") or "").strip()
        try:
            switch_profiles.set_default_remote_profile(switch_url, hermes_api_key or None)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, switch_profiles.secret_error_message(exc)) from exc
    elif mode == "local":
        switch_profiles.set_default_local_profile()
    else:
        raise HTTPException(400, "mode must be local or remote")
    return _hermes_connection_response()


@router.get("/hermes/mcp-servers")
def hermes_mcp_servers() -> dict:
    return _mcp_server_response(_read_desktop_settings())


@router.put("/hermes/mcp-servers")
async def set_hermes_mcp_servers(body: dict = Body(...)) -> dict:
    settings = _read_desktop_settings()
    servers = _mcp_servers_from_body(body)
    if servers:
        settings["mcpServers"] = servers
    else:
        settings.pop("mcpServers", None)
    _write_desktop_settings(settings)
    await bridge_client.refresh_local_mcp_servers()
    return _mcp_server_response(settings)


@router.get("/switch-profiles")
def list_switch_profiles() -> list[SwitchProfile]:
    return [SwitchProfile.model_validate(switch_profiles.profile_response(profile)) for profile in switch_profiles.list_profiles()]


@router.post("/switch-profiles")
def create_switch_profile(body: CreateSwitchProfileRequest) -> SwitchProfile:
    try:
        profile = switch_profiles.create_profile(body.name, body.switch_url, body.hermes_api_key)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, switch_profiles.secret_error_message(exc)) from exc
    return SwitchProfile.model_validate(switch_profiles.profile_response(profile))


@router.patch("/switch-profiles/{profile_id}")
def update_switch_profile(profile_id: str, body: UpdateSwitchProfileRequest) -> SwitchProfile:
    try:
        profile = switch_profiles.update_profile(
            profile_id,
            body.name,
            body.switch_url,
            body.hermes_api_key,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, switch_profiles.secret_error_message(exc)) from exc
    return SwitchProfile.model_validate(switch_profiles.profile_response(profile))


@router.delete("/switch-profiles/{profile_id}")
def delete_switch_profile(profile_id: str) -> dict[str, bool]:
    if any(workspace.connection_id == profile_id for workspace in db.list_workspaces()):
        raise HTTPException(409, "switch profile is used by a workspace")
    try:
        switch_profiles.delete_profile(profile_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}

@router.get("/hermes/slash-commands")
async def hermes_slash_commands(sessionId: str | None = None, workspaceId: str | None = None) -> list[SlashCommand]:
    method = _require_engine_method(_engine_from_context(sessionId, workspaceId), "list_slash_commands")
    try:
        return [SlashCommand.model_validate(item) for item in await method()]
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return []
        raise HTTPException(503, f"Hermes slash commands unavailable: {exc}") from exc
    except Exception as exc:
        raise HTTPException(503, f"Hermes slash commands unavailable: {exc}") from exc


@router.get("/hermes/models")
async def hermes_models(sessionId: str | None = None, workspaceId: str | None = None) -> HermesModelsResponse:
    method = _require_engine_method(_engine_from_context(sessionId, workspaceId), "list_models")
    try:
        return _models_response(await method())
    except Exception as exc:
        raise HTTPException(503, f"Hermes models unavailable: {exc}") from exc


@router.get("/hermes/usage")
async def hermes_usage(sessionId: str | None = None) -> HermesUsageResponse:
    method = _require_engine_method(_engine_from_context(sessionId, None), "get_usage")
    try:
        return HermesUsageResponse.model_validate(await method(sessionId))
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return HermesUsageResponse(unavailable_reason="Hermes usage endpoint unavailable")
        raise HTTPException(503, f"Hermes usage unavailable: {exc}") from exc
    except Exception as exc:
        raise HTTPException(503, f"Hermes usage unavailable: {exc}") from exc


@router.get("/hermes/runtime")
async def hermes_runtime(sessionId: str | None = None) -> HermesRuntimeResponse:
    method = _require_engine_method(_engine_from_context(sessionId, None), "get_runtime")
    try:
        return HermesRuntimeResponse.model_validate(await method(sessionId))
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return HermesRuntimeResponse()
        raise HTTPException(503, f"Hermes runtime unavailable: {exc}") from exc
    except Exception as exc:
        raise HTTPException(503, f"Hermes runtime unavailable: {exc}") from exc


@router.get("/hermes/default-model")
async def hermes_default_model(sessionId: str | None = None, workspaceId: str | None = None) -> SessionModel:
    method = _require_engine_method(_engine_from_context(sessionId, workspaceId), "get_default_model")
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
async def set_hermes_default_model(body: SetModelRequest, sessionId: str | None = None, workspaceId: str | None = None) -> SessionModel:
    if not body.provider or not body.model:
        raise HTTPException(400, "provider and model are required")
    method = _require_engine_method(_engine_from_context(sessionId, workspaceId), "set_default_model")
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
async def hermes_vision_model(sessionId: str | None = None, workspaceId: str | None = None) -> ModelSetting:
    method = _require_engine_method(_engine_from_context(sessionId, workspaceId), "get_vision_model")
    try:
        return ModelSetting.model_validate(await method())
    except Exception as exc:
        raise HTTPException(503, f"Hermes vision model unavailable: {exc}") from exc


@router.put("/hermes/vision-model")
async def set_hermes_vision_model(body: SetModelRequest, sessionId: str | None = None, workspaceId: str | None = None) -> ModelSetting:
    has_provider = bool(body.provider and body.provider.strip())
    has_model = bool(body.model and body.model.strip())
    if has_provider != has_model:
        raise HTTPException(400, "provider and model must both be set or both be empty")
    method = _require_engine_method(_engine_from_context(sessionId, workspaceId), "set_vision_model")
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
