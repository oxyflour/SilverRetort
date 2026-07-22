"""Route iframe artifact origins into their bound workspace resources."""

import os
import re
from urllib.parse import quote, urlsplit, urlunsplit

from starlette.responses import PlainTextResponse

import db


ARTIFACT_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62})$")
BRIDGE_PATH = "/artifact-bridge-v1.js"


def _base_url():
    configured = os.getenv("SILVERRETORT_ARTIFACT_ORIGIN_BASE_URL", "").strip()
    value = configured or f"http://artifact.localhost:{int(os.getenv('LISTEN_PORT', '23001'))}"
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.path.rstrip("/"):
        raise RuntimeError("invalid SILVERRETORT_ARTIFACT_ORIGIN_BASE_URL")
    return parsed


def artifact_origin_url(artifact_id: str, path: str = "", query: str = "") -> str:
    """Build a dedicated-origin URL whose host identifies one artifact."""
    if not ARTIFACT_ID_RE.fullmatch(artifact_id):
        raise ValueError("invalid artifact id")
    base = _base_url()
    host = f"{artifact_id}.{base.hostname}"
    netloc = f"{host}:{base.port}" if base.port is not None else host
    resource_path = "/" + quote(path.lstrip("/"), safe="/@:+-._~!$&'()*,;=")
    return urlunsplit((base.scheme, netloc, resource_path, query, ""))


def _artifact_id_from_host(host: str) -> tuple[bool, str | None]:
    hostname = host.partition(":")[0].lower().rstrip(".")
    suffix = f".{_base_url().hostname.lower().rstrip('.')}"
    if not hostname.endswith(suffix):
        return False, None
    artifact_id = hostname[: -len(suffix)]
    return True, artifact_id if ARTIFACT_ID_RE.fullmatch(artifact_id) else None


async def _reject(scope, receive, send, message: str = "artifact not found") -> None:
    if scope["type"] == "websocket":
        await send({"type": "websocket.close", "code": 1008, "reason": message})
        return
    await PlainTextResponse(message, status_code=404)(scope, receive, send)


class ArtifactOriginMiddleware:
    """Map every path on ``<artifact-id>.artifact.localhost`` to that artifact."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        matched, artifact_id = _artifact_id_from_host(headers.get(b"host", b"").decode("latin-1"))
        if not matched:
            await self.app(scope, receive, send)
            return
        if artifact_id is None:
            await _reject(scope, receive, send)
            return
        if scope.get("path") == BRIDGE_PATH:
            await self.app(scope, receive, send)
            return

        artifact = db.get_artifact(artifact_id)
        if artifact is None or artifact.type != "iframe" or not isinstance(artifact.payload, dict):
            await _reject(scope, receive, send)
            return
        session = db.get_session(artifact.session_id)
        if session is None:
            await _reject(scope, receive, send)
            return

        request_path = scope.get("path", "/")
        config = artifact.payload.get("workspacePort")
        if isinstance(config, dict):
            port = config.get("port")
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                await _reject(scope, receive, send, "invalid artifact port")
                return
            target_path = (
                f"/api/workspace-proxy/workspace/{session.workspace_id}/port/{port}"
                f"/{request_path.lstrip('/')}"
            )
        elif isinstance(artifact.payload.get("path"), str) and scope["type"] == "http":
            suffix = request_path.lstrip("/")
            target_path = f"/api/artifacts/{artifact_id}/content/" + suffix
            state = dict(scope.get("state") or {})
            state["silverretort_artifact_origin"] = True
            scope = {**scope, "state": state}
        else:
            await _reject(scope, receive, send)
            return

        encoded_path = quote(target_path, safe="/@:+-._~!$&'()*,;=").encode("ascii")
        await self.app({**scope, "path": target_path, "raw_path": encoded_path}, receive, send)
