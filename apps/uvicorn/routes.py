"""REST API + 常驻事件通道。路径与 packages/protocol 的 ApiClient 一一对应。"""

import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

import db
import events
import mcp_server
import runs
from engines import create_engine
from models import (
    ApiModel,
    Artifact,
    Attachment,
    CreateSessionRequest,
    Message,
    SendChatRequest,
    SendChatResponse,
    Session,
    TextPart,
    UpdateSessionRequest,
)

router = APIRouter(prefix="/api")
engine = create_engine()

DEFAULT_TITLE = "新会话"


# ---- sessions ----

@router.get("/sessions")
def list_sessions() -> list[Session]:
    return db.list_sessions()


@router.post("/sessions")
def create_session(body: CreateSessionRequest) -> Session:
    return db.create_session(uuid.uuid4().hex, body.title or DEFAULT_TITLE)


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
        db.rename_session(session_id, body.text[:30] or DEFAULT_TITLE)

    run_id = uuid.uuid4().hex
    runs.start_run(engine, session_id, run_id, history, user_message, assistant_message)
    return SendChatResponse(
        run_id=run_id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
    )


@router.post("/sessions/{session_id}/stop")
async def stop_run(session_id: str) -> dict[str, bool]:
    return {"ok": runs.stop_run(session_id)}


# ---- files ----

@router.post("/files")
async def upload_file(file: UploadFile) -> Attachment:
    content = await file.read()
    file_id = uuid.uuid4().hex
    mime = file.content_type or "application/octet-stream"
    path = db.files_dir() / file_id
    path.write_bytes(content)
    attachment = Attachment(
        id=file_id,
        name=file.filename or file_id,
        mime_type=mime,
        size=len(content),
        kind="image" if mime.startswith("image/") else "file",
    )
    db.insert_file(attachment, str(path))
    return attachment


@router.get("/files/{file_id}")
def get_file(file_id: str) -> FileResponse:
    found = db.get_file(file_id)
    if found is None:
        raise HTTPException(404, "file not found")
    attachment, path = found
    return FileResponse(path, media_type=attachment.mime_type, filename=attachment.name)


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
