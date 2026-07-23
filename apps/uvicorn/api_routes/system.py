"""Application control and event routes."""

import os
import threading

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

import events

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
