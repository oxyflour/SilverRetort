"""Workspace file and local image routes."""

import mimetypes
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

import httpx
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse

import db
import workspace_service
from api_routes.artifacts import _workspace_file_response
from models import Attachment

router = APIRouter()


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
