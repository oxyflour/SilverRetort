"""Shared MCP tool implementations for HTTP and bridge transports."""

import uuid
from typing import Any, Callable
from urllib.parse import urlparse

import db
import events
import workspace_service
from models import Artifact

RenderDefinition = dict[str, Any]

BUILTIN_RENDER_DEFINITIONS: list[RenderDefinition] = [
    {
        "type": "iframe",
        "description": (
            "Iframe artifact served from a workspace-relative HTML entry file, "
            "an external http(s) URL, or a workspacePort HTTP preview server. "
            "For workspacePort, path is a URL route served by that HTTP server, "
            "not a workspace file path."
        ),
        "payloadSchema": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["path"],
                    "properties": {"path": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["url"],
                    "properties": {
                        "url": {"type": "string", "format": "uri", "pattern": "^https?://"}
                    },
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["workspacePort"],
                    "properties": {
                        "workspacePort": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["port"],
                            "properties": {
                                "port": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": 65535,
                                    "description": "Port for a server already listening on 127.0.0.1 inside the current workspace.",
                                },
                                "path": {
                                    "type": "string",
                                    "description": (
                                        "Optional URL route on that server. Use an empty string or omit when the server "
                                        "serves its entry at /. Do not put workspace-relative file paths such as "
                                        "site/index.html here unless the server itself serves that exact URL route."
                                    ),
                                },
                            },
                        }
                    },
                },
            ],
        },
    },
    {
        "type": "image",
        "description": "Image artifact by URL, data URI, or local path.",
        "payloadSchema": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["url"],
                    "properties": {"url": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["src"],
                    "properties": {"src": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["dataUri"],
                    "properties": {"dataUri": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["path"],
                    "properties": {"path": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["filePath"],
                    "properties": {"filePath": {"type": "string"}},
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["localPath"],
                    "properties": {"localPath": {"type": "string"}},
                },
            ],
        },
    },
    {
        "type": "markdown",
        "description": "Markdown document artifact.",
        "payloadSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"text": {"type": "string"}},
        },
    },
]
_render_definitions: list[RenderDefinition] = list(BUILTIN_RENDER_DEFINITIONS)


def _merge_with_builtin_renderers(renderers: list[RenderDefinition]) -> list[RenderDefinition]:
    merged = {renderer["type"]: renderer for renderer in BUILTIN_RENDER_DEFINITIONS}
    for renderer in renderers:
        renderer_type = renderer["type"]
        existing = merged.get(renderer_type, {})
        next_renderer = {**existing, **renderer}
        if "payloadSchema" not in renderer and "payloadSchema" in existing:
            next_renderer["payloadSchema"] = existing["payloadSchema"]
        if "description" not in renderer and "description" in existing:
            next_renderer["description"] = existing["description"]
        merged[renderer_type] = next_renderer
    return list(merged.values())


def set_render_types(types: list[str]) -> None:
    set_render_definitions([{"type": type} for type in types])


def set_render_definitions(renderers: list[RenderDefinition]) -> None:
    global _render_definitions
    valid_renderers = [
        renderer
        for renderer in renderers
        if isinstance(renderer, dict) and isinstance(renderer.get("type"), str) and renderer["type"]
    ]
    _render_definitions = _merge_with_builtin_renderers(valid_renderers)


def supported_render_types() -> list[str]:
    return [str(renderer["type"]) for renderer in _render_definitions]


def supported_render_definitions() -> list[RenderDefinition]:
    return list(_render_definitions)


def validate_render_type(type: str) -> str | None:
    render_types = supported_render_types()
    if type in render_types:
        return None
    supported = ", ".join(render_types) or "(none)"
    return f"error: unsupported artifact type: {type}; supported types: {supported}"


def validate_iframe_payload(session_id: str, payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return "error: iframe payload must be {path: <workspace-relative path>}, {url: <http(s) URL>}, or {workspacePort: {port, path?}}"
    if set(payload) == {"url"} and isinstance(payload.get("url"), str):
        parsed = urlparse(payload["url"])
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return None
        return "error: iframe payload url must be an absolute http(s) URL"
    if set(payload) == {"workspacePort"} and isinstance(payload.get("workspacePort"), dict):
        config = payload["workspacePort"]
        if any(key not in {"port", "path"} for key in config):
            return "error: iframe workspacePort payload only supports port and path"
        port = config.get("port")
        if isinstance(port, bool) or not isinstance(port, int) or port < 1 or port > 65535:
            return "error: iframe workspacePort.port must be an integer from 1 to 65535"
        path = config.get("path")
        if path is not None and not isinstance(path, str):
            return "error: iframe workspacePort.path must be a string"
        session = db.get_session(session_id)
        if session is None:
            return f"error: session not found: {session_id}"
        proxy_error = workspace_service.require_workspace_proxy_sync(session.workspace_id)
        if proxy_error is not None:
            return f"error: {proxy_error}"
        return None
    if set(payload) != {"path"} or not isinstance(payload.get("path"), str):
        return "error: iframe payload must be {path: <workspace-relative path>}, {url: <http(s) URL>}, or {workspacePort: {port, path?}}"
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


def _show_artifact_result(artifact: Artifact) -> dict[str, str]:
    result = {"artifactId": artifact.id}
    payload = artifact.payload
    if artifact.type != "iframe" or not isinstance(payload, dict):
        return result
    config = payload.get("workspacePort")
    if not isinstance(config, dict):
        return result
    port = config.get("port")
    if isinstance(port, bool) or not isinstance(port, int):
        return result
    session = db.get_session(artifact.session_id)
    if session is None:
        return result
    result["baseUrl"] = workspace_service.local_workspace_proxy_url(
        session.workspace_id,
        port,
    )
    return result


def ui_show_artifact(
    session_id: str, type: str, title: str, payload: dict[str, Any] | None = None
) -> dict[str, str] | str:
    """Show an artifact in the user's right panel and return artifact metadata.

    For iframe artifacts, payload must be {path: <workspace-relative HTML
    entry file>}, {url: <absolute http(s) URL>}, or
    {workspacePort: {port: <1-65535>, path?: <server path>}}. For path artifacts, put
    referenced local resources in the same directory as that HTML file or in
    child directories, then reference them with relative URLs such as ./style.css
    or ./assets/app.js. Parent-directory assets are not served. Path artifacts
    may also load external http(s) resources and embed external http(s) frames.
    For workspacePort artifacts, start the HTTP server inside the current
    workspace and bind it to 127.0.0.1 on the given port. workspacePort.path is
    an HTTP route on that running server, not a workspace-relative file path.
    If the preview page is available at http://127.0.0.1:8766/, use
    {workspacePort: {port: 8766}} or {workspacePort: {port: 8766, path: ""}}.
    Do not use {workspacePort: {port: 8766, path: "project/index.html"}}
    merely because project/index.html is the file you created in the workspace;
    that will request http://127.0.0.1:8766/project/index.html and usually 404.
    Only set path when you have verified the server responds at that URL route,
    for example path: "preview/" if http://127.0.0.1:8766/preview/ works.
    Configure the server with the proxy path prefix, or use relative resource
    URLs; the proxy does not rewrite HTML, CSS, or JavaScript content. In page
    code, avoid root-relative requests like fetch('/offer') unless the server is
    mounted at origin root; use fetch('offer') or the returned baseUrl instead.
    workspacePort is only a transparent proxy; it does not create application
    endpoints. If the iframe page uses POST/PUT/PATCH/DELETE requests such as
    fetch('interactive', {method: 'POST'}) or fetch('camera', {method: 'POST'}),
    the server running on that port must implement those exact methods and
    routes. Do not serve only static HTML with a static file server and then add
    JavaScript calls to missing API routes. Before calling this tool for an
    interactive app, verify the entry and every API route through the proxy with
    curl or fetch, including POST routes.

    To return a user interaction from an iframe to the agent, include
    <script src="/artifact-bridge-v1.js"></script> in the HTML and call
    window.silverRetort.setContext(action, jsonData, {displayText: "summary"})
    when meaningful UI state changes. Debounce rapid changes in complex UIs.
    The host saves only the latest revision and does not start an agent run.
    The context is attached when the user next sends a normal chat message.
    Context must be JSON and no larger than 64 KiB. This tool returns
    {artifactId, baseUrl?} immediately and does not wait for context updates.
    For workspacePort iframe artifacts, baseUrl is the workspace proxy resource
    root to use when configuring a preview server base path. workspacePort.path
    is an HTTP route on that server, not a workspace-relative file path.
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
    return _show_artifact_result(artifact)


def ui_update_artifact(artifact_id: str, payload: dict[str, Any]) -> str:
    """Replace an existing artifact payload.

    An iframe payload must be {path: <workspace-relative HTML path>},
    {url: <absolute http(s) URL>}, or {workspacePort: {port, path?}}.
    Interactive iframe code should use
    /artifact-bridge-v1.js to save user context; do not put that context into
    this payload.
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


def ui_list_render_types() -> list[RenderDefinition]:
    """List artifact renderers currently registered by the frontend."""
    return supported_render_definitions()


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
