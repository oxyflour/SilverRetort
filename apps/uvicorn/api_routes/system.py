"""Application control, events, and UI capability routes."""

import os
import threading

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

import events
import mcp_server
from models import ApiModel

router = APIRouter()


@router.post("/app/restart")
def restart_app() -> dict:
    def exit_soon() -> None:
        os._exit(42)

    threading.Timer(0.2, exit_soon).start()
    return {"ok": True}

@router.get("/events")
async def event_stream() -> EventSourceResponse:
    return EventSourceResponse(events.subscribe())


# ---- ui capability report ----

class RenderTypesRequest(ApiModel):
    types: list[str] = []
    renderers: list[dict] = []
    artifact_modules: list[dict] = []


@router.post("/render-types")
def report_render_types(body: RenderTypesRequest) -> dict[str, bool]:
    if body.renderers:
        mcp_server.set_render_definitions(body.renderers)
    else:
        mcp_server.set_render_types(body.types)
    mcp_server.set_artifact_modules(body.artifact_modules)
    return {"ok": True}
