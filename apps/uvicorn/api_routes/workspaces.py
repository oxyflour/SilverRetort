"""Workspace, session, and message routes."""

import uuid

from fastapi import APIRouter, HTTPException

import db
import runs
import switch_profiles
import workspace_service
import workspace_templates
from api_routes.common import DEFAULT_TITLE, TOOL_SUMMARY_LIMIT, _require_engine_method, _workspace_response
from engines import create_engine_for_workspace
from models import (
    CreateSessionRequest,
    CreateWorkspaceRequest,
    Message,
    MessageSearchResponse,
    Session,
    SessionModel,
    SetModelRequest,
    ToolCall,
    UpdateSessionRequest,
    UpdateWorkspaceRequest,
    Workspace,
    WorkspaceTemplate,
)

router = APIRouter()


@router.get("/sessions")
def list_sessions() -> list[Session]:
    return db.list_sessions()


@router.get("/messages/search")
def search_messages(q: str = "") -> MessageSearchResponse:
    query = q.strip()
    if not query:
        raise HTTPException(400, "query is required")
    if len(query) > 200:
        raise HTTPException(400, "query is too long")
    return MessageSearchResponse(query=query, results=db.search_messages(query))

@router.get("/workspaces")
async def list_workspaces() -> list[Workspace]:
    return [_workspace_response(workspace) for workspace in db.list_workspaces()]


@router.get("/workspace-templates", response_model_exclude_none=True)
def list_workspace_templates() -> list[WorkspaceTemplate]:
    return workspace_templates.list_templates()


@router.post("/workspaces")
async def create_workspace(body: CreateWorkspaceRequest) -> Workspace:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "workspace name is required")
    connection_id = body.connection_id or switch_profiles.default_profile_id()
    if switch_profiles.get_profile(connection_id) is None:
        raise HTTPException(400, "switch profile not found")
    if body.template_id and workspace_templates.get_template(body.template_id) is None:
        raise HTTPException(400, "workspace template not found")
    capability = await workspace_service.capability(connection_id=connection_id)
    if not capability.get("supported") or not capability.get("writable"):
        raise HTTPException(503, "Workspace creation is unavailable for this switchUrl")
    workspace_id = uuid.uuid4().hex
    workspace = db.create_workspace(
        workspace_id,
        name,
        "creating",
        connection_id,
        body.template_id,
    )
    try:
        await workspace_service.create_remote(workspace_id)
    except Exception as exc:
        db.delete_workspace(workspace_id)
        raise HTTPException(503, f"Hermes workspace unavailable: {exc}") from exc
    db.set_workspace_status(workspace_id, "active")
    refreshed = db.get_workspace(workspace_id)
    return _workspace_response(refreshed) if refreshed is not None else workspace


@router.patch("/workspaces/{workspace_id}")
def rename_workspace(workspace_id: str, body: UpdateWorkspaceRequest) -> Workspace:
    workspace = db.rename_workspace(workspace_id, body.name.strip())
    if workspace is None:
        raise HTTPException(404, "workspace not found")
    return _workspace_response(workspace)


@router.delete("/workspaces/{workspace_id}")
async def delete_workspace(workspace_id: str, force: bool = False) -> dict[str, bool]:
    workspace = db.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(404, "workspace not found")
    if switch_profiles.get_profile(workspace.connection_id) is None and not force:
        raise HTTPException(
            409,
            "The workspace profile is no longer available. Force delete the workspace to remove its local record.",
        )
    for session in db.list_sessions():
        if session.workspace_id == workspace_id:
            runs.stop_run(session.id)
    db.set_workspace_status(workspace_id, "deleting")
    if not force:
        try:
            await workspace_service.delete_remote(workspace_id)
        except Exception as exc:
            db.set_workspace_status(workspace_id, "error")
            raise HTTPException(503, f"failed to delete Hermes workspace: {exc}") from exc
    db.delete_workspace(workspace_id)
    if not db.list_workspaces():
        fallback_id = uuid.uuid4().hex
        fallback = db.create_workspace(
            fallback_id,
            "Default workspace",
            "active" if force else "creating",
            switch_profiles.default_profile_id(),
        )
        if not force:
            await workspace_service.create_remote(fallback.id)
            db.set_workspace_status(fallback.id, "active")
    return {"ok": True}


@router.post("/workspaces/{workspace_id}/sessions")
def create_session(workspace_id: str, body: CreateSessionRequest) -> Session:
    workspace = db.get_workspace(workspace_id)
    if workspace is None or workspace.status != "active":
        raise HTTPException(409, "workspace is unavailable")
    if switch_profiles.get_profile(workspace.connection_id) is None:
        raise HTTPException(
            409,
            "The workspace profile is no longer available. Force delete the workspace to remove its local record.",
        )
    return db.create_session(uuid.uuid4().hex, workspace_id, body.title or DEFAULT_TITLE)


@router.patch("/sessions/{session_id}")
def rename_session(session_id: str, body: UpdateSessionRequest) -> Session:
    session = db.rename_session(session_id, body.title)
    if session is None:
        raise HTTPException(404, "session not found")
    return session


@router.get("/sessions/{session_id}/model")
async def get_session_model(session_id: str) -> SessionModel:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    method = _require_engine_method(create_engine_for_workspace(session.workspace_id), "get_session_model")
    try:
        return SessionModel.model_validate(await method(session_id))
    except Exception as exc:
        raise HTTPException(503, f"Hermes session model unavailable: {exc}") from exc


@router.put("/sessions/{session_id}/model")
async def set_session_model(session_id: str, body: SetModelRequest) -> SessionModel:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    method = _require_engine_method(create_engine_for_workspace(session.workspace_id), "set_session_model")
    try:
        return SessionModel.model_validate(
            await method(session_id, body.provider, body.model, body.model_id)
        )
    except Exception as exc:
        raise HTTPException(503, f"failed to set Hermes session model: {exc}") from exc


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    session = db.get_session(session_id)
    if session is not None:
        engine = create_engine_for_workspace(session.workspace_id)
        clear_goal = getattr(engine, "goal_command", None)
        if clear_goal is not None:
            try:
                await clear_goal(session_id, "/goal clear")
            except Exception:
                pass
    runs.stop_run(session_id)
    db.delete_session(session_id)
    return {"ok": True}


TOOL_SUMMARY_LIMIT = 240


def _compact_message(message: Message) -> Message:
    compact_message = message.model_copy(deep=True)
    for part in compact_message.parts:
        if getattr(part, "type", None) != "tool":
            continue
        tool_call = part.tool_call
        if tool_call.detail and len(tool_call.detail) > TOOL_SUMMARY_LIMIT:
            tool_call.detail = tool_call.detail[:TOOL_SUMMARY_LIMIT] + "..."
            tool_call.detail_truncated = True
        if tool_call.result and len(tool_call.result) > TOOL_SUMMARY_LIMIT:
            tool_call.result = tool_call.result[:TOOL_SUMMARY_LIMIT] + "..."
            tool_call.result_truncated = True
    return compact_message


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str, compact: bool = False) -> list[Message]:
    messages = db.list_messages(session_id)
    return [_compact_message(message) for message in messages] if compact else messages


@router.get("/sessions/{session_id}/messages/{message_id}/tools/{tool_call_id}")
def get_message_tool(
    session_id: str, message_id: str, tool_call_id: str
) -> ToolCall:
    message = db.get_message(session_id, message_id)
    if message is None:
        raise HTTPException(404, "message not found")
    for part in message.parts:
        if getattr(part, "type", None) == "tool" and part.tool_call.id == tool_call_id:
            return part.tool_call
    raise HTTPException(404, "tool call not found")
