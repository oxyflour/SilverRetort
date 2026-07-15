"""Shared MCP tool implementations for HTTP and bridge transports."""

import uuid
from typing import Any, Callable

import db
import events
import workspace_service
from models import Artifact

BUILTIN_RENDER_TYPES = ["iframe", "image", "markdown"]
_render_types: list[str] = list(BUILTIN_RENDER_TYPES)


def set_render_types(types: list[str]) -> None:
    global _render_types
    _render_types = types or list(BUILTIN_RENDER_TYPES)


def supported_render_types() -> list[str]:
    return list(_render_types)


def validate_render_type(type: str) -> str | None:
    if type in _render_types:
        return None
    supported = ", ".join(_render_types) or "(none)"
    return f"error: unsupported artifact type: {type}; supported types: {supported}"


def validate_iframe_payload(session_id: str, payload: Any) -> str | None:
    if not isinstance(payload, dict) or set(payload) != {"path"} or not isinstance(payload.get("path"), str):
        return "error: iframe payload must be exactly {path: <workspace-relative path>}"
    session = db.get_session(session_id)
    if session is None:
        return f"error: session not found: {session_id}"
    try:
        workspace_service.stat_workspace_file_sync(session.workspace_id, payload["path"])
    except (ValueError, FileNotFoundError):
        return f"error: workspace file not found: {payload['path']}"
    except Exception as exc:
        return f"error: workspace file unavailable: {exc}"
    return None


def ui_show_artifact(
    session_id: str, type: str, title: str, payload: dict[str, Any] | None = None
) -> str:
    """Show an artifact in the user's right panel and return its artifact_id.

    For iframe artifacts, payload.path must point to a workspace-relative HTML
    entry file. Put referenced resources in the same directory as that HTML file
    or in child directories, then reference them with relative URLs such as
    ./style.css or ./assets/app.js. Parent-directory assets are not served.

    To return a user interaction from an iframe to the agent, include
    <script src="/artifact-bridge-v1.js"></script> in the HTML and call
    window.silverRetort.setContext(action, jsonData, {displayText: "summary"})
    when meaningful UI state changes. Debounce rapid changes in complex UIs.
    The host saves only the latest revision and does not start an agent run.
    The context is attached when the user next sends a normal chat message.
    Context must be JSON and no larger than 64 KiB. This tool returns the
    artifact_id immediately and does not wait for context updates.
    """
    if db.get_session(session_id) is None:
        return f"error: session not found: {session_id}"
    type_error = validate_render_type(type)
    if type_error is not None:
        return type_error
    if type == "iframe":
        payload_error = validate_iframe_payload(session_id, payload)
        if payload_error is not None:
            return payload_error
    artifact = Artifact(
        id=uuid.uuid4().hex,
        session_id=session_id,
        type=type,
        title=title,
        payload=payload,
        created_at=db.now_iso(),
    )
    db.upsert_artifact(artifact)
    events.broadcast(events.artifact_event(session_id, artifact.model_dump(by_alias=True)))
    events.broadcast(
        events.ui_command({"command": "show-artifact", "artifactId": artifact.id}, session_id)
    )
    return artifact.id


def ui_update_artifact(artifact_id: str, payload: dict[str, Any]) -> str:
    """Replace an existing artifact payload.

    An iframe payload remains exactly {path: <workspace-relative HTML path>}.
    Interactive iframe code should use /artifact-bridge-v1.js to save user
    context; do not put that context into this payload.
    """
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        return f"error: artifact not found: {artifact_id}"
    if artifact.type == "iframe":
        payload_error = validate_iframe_payload(artifact.session_id, payload)
        if payload_error is not None:
            return payload_error
    artifact.payload = payload
    db.upsert_artifact(artifact)
    events.broadcast(
        events.ui_command(
            {"command": "update-artifact", "artifactId": artifact_id, "payload": payload},
            artifact.session_id,
        )
    )
    return "ok"


def ui_list_render_types() -> list[str]:
    """List artifact renderer types currently registered by the frontend."""
    return supported_render_types()


TOOL_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "ui_show_artifact": ui_show_artifact,
    "ui_update_artifact": ui_update_artifact,
    "ui_list_render_types": ui_list_render_types,
}


def call_tool(name: str, args: dict[str, Any] | None = None) -> Any:
    tool = TOOL_FUNCTIONS.get(name)
    if tool is None:
        raise ValueError(f"unknown MCP tool: {name}")
    return tool(**(args or {}))
