"""常驻事件通道的广播器：所有 run 事件与 MCP UI 命令都经这里推给前端。

事件为 camelCase JSON dict，与 packages/protocol 的 ChatEvent 对应。
"""

import asyncio
import json
from typing import Any, AsyncGenerator

_subscribers: set[asyncio.Queue] = set()


def broadcast(event: dict[str, Any]) -> None:
    for queue in list(_subscribers):
        queue.put_nowait(event)


async def subscribe() -> AsyncGenerator[str, None]:
    queue: asyncio.Queue = asyncio.Queue()
    _subscribers.add(queue)
    try:
        while True:
            event = await queue.get()
            yield json.dumps(event, ensure_ascii=False)
    finally:
        _subscribers.discard(queue)


# ---- 事件构造 ----

def user_message(session_id: str, message: dict) -> dict:
    return {"type": "user-message", "sessionId": session_id, "message": message}


def artifact_context(
    session_id: str, artifact_id: str, context: dict | None
) -> dict:
    return {
        "type": "artifact-context",
        "sessionId": session_id,
        "artifactId": artifact_id,
        "context": context,
    }

def run_started(session_id: str, run_id: str, message_id: str) -> dict:
    return {"type": "run-started", "sessionId": session_id, "runId": run_id, "messageId": message_id}


def text_delta(session_id: str, run_id: str, message_id: str, delta: str) -> dict:
    return {
        "type": "text-delta",
        "sessionId": session_id,
        "runId": run_id,
        "messageId": message_id,
        "delta": delta,
    }


def tool_start(
    session_id: str, run_id: str, message_id: str, tool_call_id: str, name: str, detail: str | None = None
) -> dict:
    event = {
        "type": "tool-start",
        "sessionId": session_id,
        "runId": run_id,
        "messageId": message_id,
        "toolCallId": tool_call_id,
        "name": name,
    }
    if detail is not None:
        event["detail"] = detail
    return event


def tool_end(
    session_id: str, run_id: str, message_id: str, tool_call_id: str, status: str, result: str | None = None
) -> dict:
    event = {
        "type": "tool-end",
        "sessionId": session_id,
        "runId": run_id,
        "messageId": message_id,
        "toolCallId": tool_call_id,
        "status": status,
    }
    if result is not None:
        event["result"] = result
    return event


def artifact_event(
    session_id: str, artifact: dict, run_id: str | None = None, message_id: str | None = None
) -> dict:
    event = {"type": "artifact", "sessionId": session_id, "artifact": artifact}
    if run_id is not None:
        event["runId"] = run_id
    if message_id is not None:
        event["messageId"] = message_id
    return event


def done(session_id: str, run_id: str, message_id: str) -> dict:
    return {"type": "done", "sessionId": session_id, "runId": run_id, "messageId": message_id}


def error(session_id: str, run_id: str, message_id: str, message: str) -> dict:
    return {
        "type": "error",
        "sessionId": session_id,
        "runId": run_id,
        "messageId": message_id,
        "message": message,
    }


def goal_state(session_id: str, goal: dict | None) -> dict:
    return {"type": "goal-state", "sessionId": session_id, "goal": goal}


def ui_command(command: dict, session_id: str | None = None) -> dict:
    event: dict[str, Any] = {"type": "ui-command", "uiCommand": command}
    if session_id is not None:
        event["sessionId"] = session_id
    return event
