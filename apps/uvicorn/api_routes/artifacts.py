"""Artifact metadata, context, and content routes."""

from pathlib import Path, PurePosixPath
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse

import artifact_contexts
import db
import workspace_service
from models import Artifact, ArtifactContext, ArtifactContextUpdateRequest

router = APIRouter()


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
    raw_entry = raw_path or ""
    entry = raw_entry.strip("/")
    if not asset_path:
        return port, f"{entry}/" if entry and raw_entry.endswith("/") else entry
    if raw_entry.endswith("/"):
        return port, (PurePosixPath(entry) / asset_path).as_posix()
    return port, (PurePosixPath(entry).parent / asset_path).as_posix() if entry else asset_path


@router.api_route(
    "/artifacts/{artifact_id}/content",
    methods=["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"],
)
@router.api_route(
    "/artifacts/{artifact_id}/content/",
    methods=["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"],
)
@router.api_route(
    "/artifacts/{artifact_id}/content/{asset_path:path}",
    methods=["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"],
)
async def get_artifact_content(
    artifact_id: str,
    request: Request,
    asset_path: str | None = None,
):
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
            await workspace_service.require_workspace_proxy(session.workspace_id)
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        port, path = _workspace_port_payload_target(payload, asset_path)
        return RedirectResponse(
            workspace_service.local_workspace_proxy_url(
                session.workspace_id,
                port,
                path,
                request.url.query,
            ),
            status_code=307,
        )
    if request.method not in {"GET", "HEAD"}:
        raise HTTPException(405, "iframe file artifacts only support GET and HEAD")
    if not isinstance(payload.get("path"), str):
        raise HTTPException(400, "iframe artifact requires payload.path")
    try:
        relative_path = workspace_service.resolve_artifact_asset(payload["path"], asset_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return await _workspace_file_response(session.workspace_id, relative_path, no_cache=True)
