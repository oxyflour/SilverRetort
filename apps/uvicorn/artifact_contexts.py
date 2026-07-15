"""Persist iframe state until the user's next normal chat turn."""

import json

from fastapi import HTTPException

import db
import events
from models import ArtifactContext, ArtifactContextUpdateRequest

CONTEXT_LIMIT = 64 * 1024


def _require_iframe_artifact(artifact_id: str):
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, "artifact not found")
    if artifact.type != "iframe":
        raise HTTPException(400, "artifact does not accept iframe context")
    if db.get_session(artifact.session_id) is None:
        raise HTTPException(404, "artifact session not found")
    return artifact


def set_context(
    artifact_id: str,
    body: ArtifactContextUpdateRequest,
) -> ArtifactContext:
    artifact = _require_iframe_artifact(artifact_id)
    action = body.action.strip()
    if not action:
        raise HTTPException(400, "artifact context action is required")
    display_text = (body.display_text.strip() or None) if body.display_text else None
    encoded = json.dumps(
        {"action": action, "data": body.data, "displayText": display_text},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(encoded) > CONTEXT_LIMIT:
        raise HTTPException(413, "artifact context exceeds 64 KiB")

    context = db.set_artifact_context(
        artifact.id,
        artifact.session_id,
        action,
        body.data,
        display_text,
    )
    events.broadcast(
        events.artifact_context(
            artifact.session_id,
            artifact.id,
            context.model_dump(by_alias=True),
        )
    )
    return context


def clear_context(artifact_id: str) -> None:
    artifact = _require_iframe_artifact(artifact_id)
    db.clear_artifact_context(artifact.id)
    events.broadcast(events.artifact_context(artifact.session_id, artifact.id, None))
