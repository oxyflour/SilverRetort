"""REST API + 常驻事件通道。路径与 packages/protocol 的 ApiClient 一一对应。"""

import mimetypes
import os
from pathlib import Path
import uuid
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

import httpx
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from sse_starlette.sse import EventSourceResponse

import db
import events
import mcp_server
import runs
import workspace_service
from engines import create_engine
from models import (
    ApiModel,
    Artifact,
    Attachment,
    CreateWorkspaceRequest,
    CreateSessionRequest,
    Message,
    RestartMessageRequest,
    SendChatRequest,
    SendChatResponse,
    Session,
    TextPart,
    UpdateSessionRequest,
    UpdateWorkspaceRequest,
    Workspace,
    WorkspaceCapability,
)

router = APIRouter(prefix="/api")
engine = create_engine()

DEFAULT_TITLE = "新会话"


def _auto_title(text: str) -> str:
    return text[:30] or DEFAULT_TITLE


# ---- sessions ----

@router.get("/sessions")
def list_sessions() -> list[Session]:
    return db.list_sessions()


@router.get("/workspaces/capability")
async def workspace_capability() -> WorkspaceCapability:
    return WorkspaceCapability.model_validate(await workspace_service.capability())


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


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    runs.stop_run(session_id)
    db.delete_session(session_id)
    return {"ok": True}


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str) -> list[Message]:
    return db.list_messages(session_id)


@router.get("/sessions/{session_id}/artifacts")
def list_artifacts(session_id: str) -> list[Artifact]:
    return db.list_artifacts(session_id)


@router.get("/artifacts/{artifact_id}")
def get_artifact(artifact_id: str) -> Artifact:
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, "artifact not found")
    return artifact


@router.get("/artifacts/{artifact_id}/content")
def get_artifact_content(artifact_id: str) -> HTMLResponse:
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, "artifact not found")
    payload = artifact.payload
    if not isinstance(payload, dict):
        raise HTTPException(400, "artifact does not contain inline HTML")
    html = payload.get("html")
    if not isinstance(html, str):
        raise HTTPException(400, "artifact does not contain inline HTML")
    return HTMLResponse(html)


# ---- chat run ----

@router.post("/sessions/{session_id}/chat")
async def send_chat(session_id: str, body: SendChatRequest) -> SendChatResponse:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    if runs.is_running(session_id):
        raise HTTPException(409, "session already has an active run")

    attachments = []
    for file_id in body.attachment_ids:
        found = db.get_file(file_id)
        if found is None:
            raise HTTPException(400, f"attachment not found: {file_id}")
        attachments.append(found[0])

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
    db.insert_message(user_message)
    db.insert_message(assistant_message)

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
    file_id = uuid.uuid4().hex
    mime = file.content_type or "application/octet-stream"
    try:
        result = await workspace_service.upload_remote(workspace_id, file)
    except Exception as exc:
        raise HTTPException(503, f"file upload failed: {exc}") from exc
    attachment = Attachment(
        id=file_id,
        workspace_id=workspace_id,
        relative_path=str(result["relativePath"]),
        name=file.filename or file_id,
        mime_type=mime,
        size=int(result["size"]),
        kind="image" if mime.startswith("image/") else "file",
    )
    db.insert_file(attachment)
    return attachment


@router.get("/workspaces/{workspace_id}/files")
def list_workspace_files(workspace_id: str) -> list[Attachment]:
    if db.get_workspace(workspace_id) is None:
        raise HTTPException(404, "workspace not found")
    return db.list_files(workspace_id)


@router.get("/workspaces/{workspace_id}/files/{file_id}")
async def get_file(workspace_id: str, file_id: str) -> StreamingResponse:
    found = db.get_file(file_id)
    if found is None or found[0].workspace_id != workspace_id:
        raise HTTPException(404, "file not found")
    attachment, _ = found
    client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10))
    response = await client.send(client.build_request(
        "GET", workspace_service.remote_file_url(workspace_id, attachment.relative_path),
        headers={"authorization": f"Bearer {os.getenv('HERMES_API_KEY', '')}"},
    ), stream=True)
    if response.status_code != 200:
        await response.aclose(); await client.aclose()
        raise HTTPException(response.status_code, "file download failed")
    async def stream():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose(); await client.aclose()
    return StreamingResponse(stream(), media_type=attachment.mime_type,
        headers={"content-disposition": f'attachment; filename="{attachment.name}"'})


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
    types: list[str]


@router.post("/render-types")
def report_render_types(body: RenderTypesRequest) -> dict[str, bool]:
    mcp_server.set_render_types(body.types)
    return {"ok": True}
