"""Chat run routes."""

import uuid

from fastapi import APIRouter, HTTPException

import db
import runs
import workspace_service
from api_routes.common import DEFAULT_TITLE, _auto_title
from engines import create_engine_for_workspace
from models import Attachment, Message, RestartMessageRequest, SendChatRequest, SendChatResponse, TextPart

router = APIRouter()


@router.post("/sessions/{session_id}/chat")
async def send_chat(session_id: str, body: SendChatRequest) -> SendChatResponse:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    if runs.is_running(session_id):
        raise HTTPException(409, "session already has an active run")

    attachments = []
    for requested in body.attachments:
        if requested.workspace_id != session.workspace_id:
            raise HTTPException(400, "attachment belongs to another workspace")
        try:
            metadata = await workspace_service.stat_workspace_file(session.workspace_id, requested.relative_path)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(400, f"attachment not found: {requested.relative_path}") from exc
        attachments.append(Attachment.model_validate(metadata))

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
    consumed_contexts = db.insert_message_with_pending_artifact_contexts(user_message)
    db.insert_message(assistant_message)
    events.broadcast(
        events.user_message(session_id, user_message.model_dump(by_alias=True))
    )
    for context in consumed_contexts:
        events.broadcast(events.artifact_context(session_id, context.artifact_id, None))

    # 棣栨潯娑堟伅鏃剁敤鍐呭鐢熸垚鏍囬
    if session.title == DEFAULT_TITLE and not history:
        db.rename_session(session_id, _auto_title(body.text))

    run_id = uuid.uuid4().hex
    runs.start_run(
        create_engine_for_workspace(session.workspace_id),
        session_id,
        session.workspace_id,
        run_id,
        history,
        user_message,
        assistant_message,
    )
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
    runs.start_run(
        create_engine_for_workspace(session.workspace_id),
        session_id,
        session.workspace_id,
        run_id,
        result.history,
        result.user_message,
        assistant_message,
    )
    return SendChatResponse(
        run_id=run_id,
        user_message_id=result.user_message.id,
        assistant_message_id=assistant_message.id,
    )


@router.post("/sessions/{session_id}/stop")
async def stop_run(session_id: str) -> dict[str, bool]:
    return {"ok": runs.stop_run(session_id)}
