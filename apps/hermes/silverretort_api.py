"""SilverRetort-specific Hermes relay endpoints."""

from collections.abc import Callable
from typing import Any, TypeVar
import asyncio
import re

from fastapi import HTTPException
from starlette.requests import Request

from model_settings import (
    collect_models,
    model_default,
    model_id,
    set_default_model,
    set_vision_model,
    vision_model,
)
from usage import usage_response

SESSION_KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
UI_OPERATION_TIMEOUT_SECONDS = 5.0
T = TypeVar("T")


async def run_ui_operation(name: str, operation: Callable[[], T]) -> T:
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(operation), timeout=UI_OPERATION_TIMEOUT_SECONDS
        )
    except TimeoutError as exc:
        raise HTTPException(503, f"Hermes UI operation timed out: {name}") from exc


def _bearer_token(headers: Any) -> str:
    header = headers.get("authorization", "")
    prefix = "bearer "
    if header.lower().startswith(prefix):
        return header[len(prefix) :].strip()
    return ""


def authorized_request(request: Request, api_key: str) -> bool:
    if not api_key.strip():
        return True
    if request.client and request.client.host.lower() in LOOPBACK_HOSTS:
        return True
    return _bearer_token(request.headers) == api_key.strip()


def _slash_command_name(text: str) -> tuple[str, str] | None:
    stripped = (text or "").strip()
    if not stripped.startswith("/"):
        return None
    parts = stripped.split(None, 1)
    command = parts[0][1:].strip()
    rest = parts[1] if len(parts) > 1 else ""
    return (command, rest) if command else None


def collect_slash_commands() -> list[dict[str, Any]]:
    from agent.skill_bundles import get_skill_bundles
    from agent.skill_commands import get_skill_commands

    commands: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key, info in sorted(get_skill_bundles().items()):
        command = key.lstrip("/")
        seen.add(command)
        commands.append(
            {
                "command": key,
                "name": str(info.get("name") or command),
                "description": str(info.get("description") or ""),
                "kind": "bundle",
            }
        )
    for key, info in sorted(get_skill_commands().items()):
        command = key.lstrip("/")
        if command in seen:
            continue
        commands.append(
            {
                "command": key,
                "name": str(info.get("name") or command),
                "description": str(info.get("description") or ""),
                "kind": "skill",
            }
        )
    return commands


def expand_slash_text(text: str, session_key: str) -> dict[str, Any]:
    parsed = _slash_command_name(text)
    if parsed is None:
        return {"handled": False}
    command, rest = parsed

    from agent.skill_bundles import (
        build_bundle_invocation_message,
        resolve_bundle_command_key,
    )
    from agent.skill_commands import (
        build_skill_invocation_message,
        build_stacked_skill_invocation_message,
        resolve_skill_command_key,
        split_stacked_skill_commands,
    )

    bundle_key = resolve_bundle_command_key(command)
    if bundle_key:
        result = build_bundle_invocation_message(
            bundle_key,
            user_instruction=rest.strip(),
            task_id=session_key,
            platform="api_server",
        )
        if result:
            expanded, loaded, missing = result
            return {
                "handled": True,
                "kind": "bundle",
                "command": bundle_key,
                "expandedText": expanded,
                "loaded": loaded,
                "missing": missing,
            }

    skill_key = resolve_skill_command_key(command)
    if not skill_key:
        return {"handled": False}

    extra_keys, instruction = split_stacked_skill_commands(rest)
    if extra_keys:
        result = build_stacked_skill_invocation_message(
            [skill_key, *extra_keys],
            user_instruction=instruction,
            task_id=session_key,
        )
        if result:
            expanded, loaded, missing = result
            return {
                "handled": True,
                "kind": "skill",
                "command": skill_key,
                "expandedText": expanded,
                "loaded": loaded,
                "missing": missing,
            }

    expanded = build_skill_invocation_message(
        skill_key,
        user_instruction=rest.strip(),
        task_id=session_key,
    )
    if not expanded:
        return {"handled": False}
    return {
        "handled": True,
        "kind": "skill",
        "command": skill_key,
        "expandedText": expanded,
        "loaded": [skill_key.lstrip("/")],
        "missing": [],
    }


def _runner() -> Any:
    try:
        from gateway.run import _gateway_runner_ref

        return _gateway_runner_ref()
    except Exception:
        return None


def _session_override(session_key: str) -> dict[str, Any] | None:
    runner = _runner()
    overrides = getattr(runner, "_session_model_overrides", None)
    if isinstance(overrides, dict):
        override = overrides.get(session_key)
        if isinstance(override, dict):
            return dict(override)
    return None


def session_model_response(session_key: str) -> dict[str, Any]:
    default = model_default()
    override = _session_override(session_key)
    active = override or default
    provider = str(active.get("provider") or "")
    model = str(active.get("model") or "")
    return {
        "sessionKey": session_key,
        "source": "session" if override else "default",
        "provider": provider,
        "model": model,
        "modelId": model_id(provider, model) if provider and model else "",
        "defaultProvider": default.get("provider", ""),
        "defaultModel": default.get("model", ""),
    }


def resolve_model_selection(body: dict[str, Any]) -> tuple[str, str]:
    provider = str(body.get("provider") or "").strip()
    model = str(body.get("model") or "").strip()
    raw_model_id = str(body.get("modelId") or "").strip()
    if provider and model:
        return provider, model
    if raw_model_id:
        for item in collect_models()["models"]:
            if item.get("id") == raw_model_id:
                return str(item["provider"]), str(item["model"])
    raise HTTPException(400, "provider and model are required")


def apply_session_model(session_key: str, provider: str, model: str) -> None:
    runner = _runner()
    if runner is None:
        raise HTTPException(503, "Hermes gateway runner unavailable")
    override: dict[str, Any] = {"model": model, "provider": provider}
    try:
        from gateway.run import _resolve_runtime_agent_kwargs_for_provider

        runtime = _resolve_runtime_agent_kwargs_for_provider(provider)
        for key in ("api_key", "base_url", "api_mode", "credential_pool"):
            if runtime.get(key) is not None:
                override[key] = runtime.get(key)
    except Exception:
        pass
    runner._session_model_overrides[session_key] = override
    try:
        runner._evict_cached_agent(session_key)
    except Exception:
        pass
    try:
        runner.session_store.set_model_override(session_key, override)
    except Exception:
        pass


def clear_session_model(session_key: str) -> None:
    runner = _runner()
    if runner is None:
        raise HTTPException(503, "Hermes gateway runner unavailable")
    try:
        runner._session_model_overrides.pop(session_key, None)
        runner._evict_cached_agent(session_key)
        runner.session_store.set_model_override(session_key, None)
    except Exception:
        pass


def runtime_status_response() -> dict[str, Any]:
    runner = _runner()
    running_agents = getattr(runner, "_running_agents", None)
    active_task_count = len(running_agents) if isinstance(running_agents, dict) else 0
    return {"busy": active_task_count > 0, "activeTaskCount": active_task_count}


def _require_auth(request: Request, api_key: str) -> None:
    if not authorized_request(request, api_key):
        raise HTTPException(401, "unauthorized")


def _session_key_from_query(request: Request) -> str:
    session_key = str(request.query_params.get("sessionKey") or "").strip()
    if not session_key or not SESSION_KEY_RE.match(session_key):
        raise HTTPException(400, "invalid sessionKey")
    return session_key


def _default_model_response() -> dict[str, Any]:
    current = model_default()
    provider = current.get("provider", "")
    model = current.get("model", "")
    return {
        **current,
        "provider": provider,
        "model": model,
        "modelId": model_id(provider, model) if provider and model else "",
    }


def _set_default_model_response(body: dict[str, Any]) -> dict[str, Any]:
    provider, model = resolve_model_selection(body)
    return set_default_model(
        provider,
        model,
        str(body.get("baseUrl") or "") if "baseUrl" in body else None,
        str(body.get("apiKey") or "") or None,
    )


def _vision_model_response() -> dict[str, Any]:
    current = vision_model()
    provider = str(current.get("provider") or "")
    model = str(current.get("model") or "")
    return {
        **current,
        "modelId": model_id(provider, model) if provider and model else "",
    }


def _set_vision_model_response(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("provider") is None and body.get("model") is None:
        return set_vision_model("", "")
    provider, model = resolve_model_selection(body)
    return set_vision_model(
        provider,
        model,
        str(body.get("baseUrl") or "") if "baseUrl" in body else None,
        str(body.get("apiKey") or "") or None,
    )


def _set_session_model_response(
    body: dict[str, Any], session_key: str
) -> dict[str, Any]:
    if body.get("modelId") is None and body.get("model") is None:
        clear_session_model(session_key)
        return session_model_response(session_key)
    provider, model = resolve_model_selection(body)
    apply_session_model(session_key, provider, model)
    return session_model_response(session_key)


def register_silverretort_routes(app: Any, api_key: str) -> None:
    @app.get("/silverretort/runtime")
    async def silverretort_runtime(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        return runtime_status_response()

    @app.get("/silverretort/slash/commands")
    async def silverretort_slash_commands(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        return await run_ui_operation(
            "slash commands", lambda: {"commands": collect_slash_commands()}
        )

    @app.post("/silverretort/slash/expand")
    async def silverretort_slash_expand(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid body")
        session_key = str(body.get("sessionKey") or "").strip()
        if session_key and not SESSION_KEY_RE.match(session_key):
            raise HTTPException(400, "invalid sessionKey")
        return await run_ui_operation(
            "slash expand",
            lambda: expand_slash_text(str(body.get("text") or ""), session_key),
        )

    @app.get("/silverretort/models")
    async def silverretort_models(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        return await run_ui_operation("models", collect_models)

    @app.get("/silverretort/usage")
    async def silverretort_usage(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        session_key = str(request.query_params.get("sessionKey") or "").strip()
        if session_key and not SESSION_KEY_RE.match(session_key):
            raise HTTPException(400, "invalid sessionKey")
        return await run_ui_operation(
            "usage", lambda: usage_response(session_key)
        )

    @app.get("/silverretort/default-model")
    async def silverretort_default_model(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        return await run_ui_operation("default model", _default_model_response)

    @app.put("/silverretort/default-model")
    async def silverretort_set_default_model(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid body")
        return await run_ui_operation(
            "set default model", lambda: _set_default_model_response(body)
        )

    @app.get("/silverretort/vision-model")
    async def silverretort_vision_model(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        return await run_ui_operation("vision model", _vision_model_response)

    @app.put("/silverretort/vision-model")
    async def silverretort_set_vision_model(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid body")
        return await run_ui_operation(
            "set vision model", lambda: _set_vision_model_response(body)
        )

    @app.get("/silverretort/session-model")
    async def silverretort_session_model(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        session_key = _session_key_from_query(request)
        return await run_ui_operation(
            "session model", lambda: session_model_response(session_key)
        )

    @app.put("/silverretort/session-model")
    async def silverretort_set_session_model(request: Request) -> dict[str, Any]:
        _require_auth(request, api_key)
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid body")
        session_key = str(body.get("sessionKey") or "").strip()
        if not session_key or not SESSION_KEY_RE.match(session_key):
            raise HTTPException(400, "invalid sessionKey")
        return await run_ui_operation(
            "set session model",
            lambda: _set_session_model_response(body, session_key),
        )
