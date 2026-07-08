"""hermes-agent 适配层：调其 OpenAI 兼容 API，归一化为内部引擎事件。

hermes 是无状态推理引擎：每次 run 传完整消息历史；session_id 与附件清单
写进 ephemeral system prompt，hermes 经 MCP（ui_* / *_user_file 工具）回连操控 UI。
"""

import base64
import json
import uuid
from typing import Any, AsyncGenerator

import httpx

import db
from models import Message

MCP_TOOL_PREFIX = "mcp__silverretort_ui__"
UI_SHOW_ARTIFACT_TOOL = f"{MCP_TOOL_PREFIX}ui_show_artifact"
UI_UPDATE_ARTIFACT_TOOL = f"{MCP_TOOL_PREFIX}ui_update_artifact"
LIST_USER_FILES_TOOL = f"{MCP_TOOL_PREFIX}list_user_files"
READ_USER_FILE_TOOL = f"{MCP_TOOL_PREFIX}read_user_file"

SYSTEM_PROMPT = """你在一个桌面聊天应用中回答用户。当前 session_id: {session_id}

你可以通过 silverretort-ui MCP 工具操控界面，调用时请使用当前工具列表里的实际函数名：
- {ui_show_artifact_tool}(session_id, type, title, payload) 在右侧面板展示内容（type 用 ui_list_render_types 查询）
- {ui_update_artifact_tool}(artifact_id, payload) 增量更新
- {list_user_files_tool}(session_id) / {read_user_file_tool}(file_id) 读取用户上传的附件
{attachments_note}"""


def _text_of(message: Message) -> str:
    return "".join(p.text for p in message.parts if p.type == "text")


def _to_openai_message(message: Message) -> dict[str, Any]:
    text = _text_of(message)
    images = [a for a in message.attachments if a.kind == "image"]
    if message.role == "user" and images:
        content: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for attachment in images:
            found = db.get_file(attachment.id)
            if found is None:
                continue
            data = open(found[1], "rb").read()
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{attachment.mime_type};base64,"
                        + base64.b64encode(data).decode("ascii")
                    },
                }
            )
        return {"role": message.role, "content": content}
    return {"role": message.role, "content": text}


def _attachments_note(history: list[Message], user_message: Message) -> str:
    lines = []
    for message in [*history, user_message]:
        for attachment in message.attachments:
            if attachment.kind != "image":
                lines.append(f"- {attachment.name} (file_id: {attachment.id}, {attachment.mime_type})")
    if not lines:
        return ""
    return "\n用户上传过以下文件（用 read_user_file 读取）：\n" + "\n".join(lines)


class HermesEngine:
    def __init__(self, base_url: str, api_key: str, model: str = "hermes-agent"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def run(
        self, session_id: str, history: list[Message], user_message: Message
    ) -> AsyncGenerator[dict[str, Any], None]:
        system = SYSTEM_PROMPT.format(
            session_id=session_id,
            ui_show_artifact_tool=UI_SHOW_ARTIFACT_TOOL,
            ui_update_artifact_tool=UI_UPDATE_ARTIFACT_TOOL,
            list_user_files_tool=LIST_USER_FILES_TOOL,
            read_user_file_tool=READ_USER_FILE_TOOL,
            attachments_note=_attachments_note(history, user_message),
        )
        messages = [{"role": "system", "content": system}]
        messages += [_to_openai_message(m) for m in history if _text_of(m) or m.attachments]
        messages.append(_to_openai_message(user_message))

        payload = {"model": self.model, "messages": messages, "stream": True}
        headers = {"authorization": f"Bearer {self.api_key}"}

        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as client:
            async with client.stream(
                "POST", f"{self.base_url}/v1/chat/completions", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode("utf-8", "replace")[:500]
                    raise RuntimeError(f"hermes HTTP {response.status_code}: {body}")
                current_event: str | None = None
                async for line in response.aiter_lines():
                    if line.startswith("event:"):
                        current_event = line[6:].strip() or None
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if current_event == "hermes.tool.progress" and isinstance(chunk, dict):
                        chunk.setdefault("type", current_event)
                    for event in _normalize_chunk(chunk):
                        yield event
                    current_event = None


def _normalize_chunk(chunk: dict[str, Any]) -> list[dict[str, Any]]:
    """把 hermes 的 chat.completion.chunk / hermes.tool.progress 归一化为内部事件。"""
    kind = chunk.get("type") or chunk.get("object") or ""

    if kind == "hermes.tool.progress" or "tool" in str(kind):
        name = chunk.get("tool") or chunk.get("tool_name") or chunk.get("name") or "tool"
        tool_id = str(
            chunk.get("toolCallId") or chunk.get("id") or chunk.get("tool_call_id") or uuid.uuid4().hex
        )
        status = str(chunk.get("status") or chunk.get("phase") or "started")
        detail = chunk.get("detail") or chunk.get("arguments") or chunk.get("args") or chunk.get("preview")
        detail = json.dumps(detail, ensure_ascii=False) if isinstance(detail, (dict, list)) else detail
        if status in ("started", "start", "running", "in_progress"):
            return [{"kind": "tool-start", "id": tool_id, "name": name, "detail": detail}]
        result = chunk.get("result") or chunk.get("output") or chunk.get("preview")
        result = json.dumps(result, ensure_ascii=False) if isinstance(result, (dict, list)) else result
        return [
            {
                "kind": "tool-end",
                "id": tool_id,
                "status": "error" if status in ("error", "failed") else "done",
                "result": result,
            }
        ]

    events: list[dict[str, Any]] = []
    for choice in chunk.get("choices") or []:
        delta = (choice.get("delta") or {}).get("content")
        if delta:
            events.append({"kind": "text", "delta": delta})
    return events
