"""Shared helpers for API route modules."""

from fastapi import HTTPException

import db
import switch_profiles
from engines import create_engine, create_engine_for_workspace
from models import HermesModel, HermesModelsResponse, Workspace

engine = create_engine()
DEFAULT_TITLE = "New chat"
TOOL_SUMMARY_LIMIT = 240


def _auto_title(text: str) -> str:
    return text[:30] or DEFAULT_TITLE


def _require_hermes_method(name: str):
    method = getattr(engine, name, None)
    if method is None:
        raise HTTPException(503, "Hermes is unavailable")
    return method


def _require_engine_method(selected_engine, name: str):
    method = getattr(selected_engine, name, None)
    if method is None:
        raise HTTPException(503, "Hermes is unavailable")
    return method


def _workspace_response(workspace: Workspace) -> Workspace:
    payload = workspace.model_dump()
    payload.update(switch_profiles.workspace_summary(workspace.id, workspace.connection_id))
    return Workspace.model_validate(payload)


def _workspace_id_from_context(sessionId: str | None = None, workspaceId: str | None = None) -> str | None:
    if workspaceId:
        return workspaceId
    if sessionId:
        session = db.get_session(sessionId)
        if session is None:
            raise HTTPException(404, "session not found")
        return session.workspace_id
    workspaces = db.list_workspaces()
    return workspaces[0].id if workspaces else None


def _engine_from_context(sessionId: str | None = None, workspaceId: str | None = None):
    return create_engine_for_workspace(_workspace_id_from_context(sessionId, workspaceId))


def _models_response(payload: dict) -> HermesModelsResponse:
    default = payload.get("default") if isinstance(payload.get("default"), dict) else {}
    return HermesModelsResponse(
        models=[HermesModel.model_validate(item) for item in payload.get("models", [])],
        default_provider=str(default.get("provider") or ""),
        default_model=str(default.get("model") or ""),
    )
