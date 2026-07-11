"""Shared MCP tool implementations for HTTP and bridge transports."""

import base64
import uuid
from typing import Any, Callable

import db
import events
from models import Artifact

BUILTIN_RENDER_TYPES = ["iframe", "image", "markdown"]
MAX_READ_BYTES = 5 * 1024 * 1024
TEXT_MIME_PREFIXES = ("text/",)
TEXT_MIME_EXACT = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/toml",
    "text/csv",
}

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


def ui_show_artifact(
    session_id: str, type: str, title: str, payload: dict[str, Any] | None = None
) -> str:
    """Show an artifact in the user's right panel and return its artifact_id."""
    if db.get_session(session_id) is None:
        return f"error: session not found: {session_id}"
    type_error = validate_render_type(type)
    if type_error is not None:
        return type_error
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
    """Replace the payload of an existing artifact."""
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        return f"error: artifact not found: {artifact_id}"
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


def list_user_files(session_id: str) -> list[dict[str, Any]]:
    """List user-uploaded attachments in a session."""
    seen: dict[str, dict[str, Any]] = {}
    for message in db.list_messages(session_id):
        for attachment in message.attachments:
            seen[attachment.id] = attachment.model_dump(by_alias=True)
    return list(seen.values())


def read_user_file(file_id: str) -> dict[str, Any]:
    """Read a user-uploaded attachment as UTF-8 text or base64."""
    found = db.get_file(file_id)
    if found is None:
        return {"error": f"file not found: {file_id}"}
    attachment, path = found
    if attachment.size > MAX_READ_BYTES:
        return {"error": f"file too large ({attachment.size} bytes), max {MAX_READ_BYTES}"}
    data = open(path, "rb").read()
    mime = attachment.mime_type
    is_text = mime.startswith(TEXT_MIME_PREFIXES) or mime in TEXT_MIME_EXACT
    if is_text:
        try:
            return {"name": attachment.name, "mimeType": mime, "text": data.decode("utf-8")}
        except UnicodeDecodeError:
            pass
    return {
        "name": attachment.name,
        "mimeType": mime,
        "base64": base64.b64encode(data).decode("ascii"),
    }


TOOL_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "ui_show_artifact": ui_show_artifact,
    "ui_update_artifact": ui_update_artifact,
    "ui_list_render_types": ui_list_render_types,
    "list_user_files": list_user_files,
    "read_user_file": read_user_file,
}


def call_tool(name: str, args: dict[str, Any] | None = None) -> Any:
    tool = TOOL_FUNCTIONS.get(name)
    if tool is None:
        raise ValueError(f"unknown MCP tool: {name}")
    return tool(**(args or {}))
