"""Run 管理：每个 session 至多一个进行中的后台 run，多个 session 可并发。

run 消费引擎事件流，assistant 消息边收边落库，事件经 events.broadcast 推给前端；
因此切换会话/刷新页面不会丢失进行中的回答。
"""

import asyncio
import uuid

import db
import events
from engines import Engine
from models import Artifact, Message, TextPart, ToolCall, ToolPart

_active: dict[str, asyncio.Task] = {}


def is_running(session_id: str) -> bool:
    task = _active.get(session_id)
    return task is not None and not task.done()


def start_run(
    engine: Engine,
    session_id: str,
    run_id: str,
    history: list[Message],
    user_message: Message,
    assistant_message: Message,
) -> None:
    if is_running(session_id):
        raise RuntimeError("session already has an active run")
    task = asyncio.create_task(
        _run(engine, session_id, run_id, history, user_message, assistant_message)
    )
    _active[session_id] = task


def stop_run(session_id: str) -> bool:
    task = _active.get(session_id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def _run(
    engine: Engine,
    session_id: str,
    run_id: str,
    history: list[Message],
    user_message: Message,
    assistant_message: Message,
) -> None:
    message = assistant_message
    events.broadcast(events.run_started(session_id, run_id, message.id))
    try:
        async for event in engine.run(session_id, history, user_message):
            kind = event["kind"]
            if kind == "text":
                delta = event["delta"]
                if message.parts and isinstance(message.parts[-1], TextPart):
                    message.parts[-1].text += delta
                else:
                    message.parts.append(TextPart(text=delta))
                events.broadcast(events.text_delta(session_id, run_id, message.id, delta))
            elif kind == "tool-start":
                message.parts.append(
                    ToolPart(
                        tool_call=ToolCall(
                            id=event["id"],
                            name=event["name"],
                            status="running",
                            detail=event.get("detail"),
                        )
                    )
                )
                events.broadcast(
                    events.tool_start(
                        session_id, run_id, message.id, event["id"], event["name"], event.get("detail")
                    )
                )
            elif kind == "tool-end":
                for part in message.parts:
                    if isinstance(part, ToolPart) and part.tool_call.id == event["id"]:
                        part.tool_call.status = event["status"]
                        part.tool_call.result = event.get("result")
                events.broadcast(
                    events.tool_end(
                        session_id, run_id, message.id, event["id"], event["status"], event.get("result")
                    )
                )
            elif kind == "artifact":
                artifact = Artifact(
                    id=event.get("id") or uuid.uuid4().hex,
                    session_id=session_id,
                    type=event["type"],
                    title=event["title"],
                    payload=event.get("payload"),
                    created_at=db.now_iso(),
                )
                db.upsert_artifact(artifact)
                message.artifact_ids.append(artifact.id)
                events.broadcast(
                    events.artifact_event(
                        session_id, artifact.model_dump(by_alias=True), run_id, message.id
                    )
                )
            db.update_message(message)

        message.status = "complete"
        db.update_message(message)
        events.broadcast(events.done(session_id, run_id, message.id))
    except asyncio.CancelledError:
        message.status = "stopped"
        db.update_message(message)
        events.broadcast(events.done(session_id, run_id, message.id))
        raise
    except Exception as exc:  # noqa: BLE001 — run 失败必须落库并通知前端
        message.status = "error"
        db.update_message(message)
        events.broadcast(events.error(session_id, run_id, message.id, str(exc)))
    finally:
        db.touch_session(session_id)
        if _active.get(session_id) is asyncio.current_task():
            _active.pop(session_id, None)
