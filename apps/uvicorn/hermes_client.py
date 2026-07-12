"""Hermes Responses API adapter."""

import json
import uuid
from typing import Any, AsyncGenerator

import httpx

import db
from models import Message, TextPart

MCP_TOOL_PREFIX = "mcp__silverretort_ui__"
UI_SHOW_ARTIFACT_TOOL = f"{MCP_TOOL_PREFIX}ui_show_artifact"
UI_UPDATE_ARTIFACT_TOOL = f"{MCP_TOOL_PREFIX}ui_update_artifact"
LIST_USER_FILES_TOOL = f"{MCP_TOOL_PREFIX}list_user_files"
READ_USER_FILE_TOOL = f"{MCP_TOOL_PREFIX}read_user_file"

SYSTEM_PROMPT = """你在一个桌面聊天应用中回答用户。当前 session_id: {session_id}
当前 workspace_id: {workspace_id}。工作区目录由 Hermes 解析；所有文件操作应限制在该工作区内。

你可以通过 silverretort-ui MCP 工具操控界面，调用时请使用当前工具列表里的实际函数名：
- {ui_show_artifact_tool}(session_id, type, title, payload) 在右侧面板展示内容（type 用 ui_list_render_types 查询）
  iframe 必须先把完整静态站点写入当前工作区，再传工作区相对入口路径，例如 payload={{"path":"site/index.html"}}；不要传内联 HTML 或外部 URL。
- {ui_update_artifact_tool}(artifact_id, payload) 增量更新
{attachments_note}"""


def _text_of(message: Message) -> str:
    return "".join(p.text for p in message.parts if p.type == "text")


def _to_openai_message(message: Message) -> dict[str, Any]:
    text = _text_of(message)
    return {"role": message.role, "content": text}


def _attachments_note(history: list[Message], user_message: Message) -> str:
    lines = []
    for message in [*history, user_message]:
        for attachment in message.attachments:
            lines.append(f"- {attachment.relative_path} ({attachment.mime_type}, {attachment.size} bytes)")
    if not lines:
        return ""
    return "\n工作区内已上传以下文件，可使用 Hermes 原生文件工具读取：\n" + "\n".join(lines)


def _flatten_response_output(output: Any) -> str | None:
    if output is None:
        return None
    if isinstance(output, str):
        return output
    if isinstance(output, dict):
        text = output.get("text")
        if text is not None:
            return str(text)
        return json.dumps(output, ensure_ascii=False)
    if isinstance(output, list):
        parts: list[str] = []
        for part in output:
            if isinstance(part, str):
                parts.append(part)
                continue
            if isinstance(part, dict):
                text = part.get("text")
                part_type = str(part.get("type") or "").lower()
                if text is not None and part_type in {"text", "input_text", "output_text"}:
                    parts.append(str(text))
                    continue
                if text is not None:
                    parts.append(str(text))
                    continue
            elif part is not None:
                parts.append(str(part))
        if parts:
            return "".join(parts)
        return json.dumps(output, ensure_ascii=False)
    return str(output)


def _tool_result_status(result: str | None) -> str:
    if result is None:
        return "done"
    try:
        payload = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        return "done"
    if not isinstance(payload, dict):
        return "done"

    error = payload.get("error")
    error_is_empty = (
        error is None
        or error is False
        or error == ""
        or (isinstance(error, (dict, list)) and not error)
    )
    exit_code = payload.get("exit_code")
    has_failed_exit_code = (
        isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code != 0
    )
    return "error" if not error_is_empty or has_failed_exit_code else "done"


def _extract_failed_response_message(payload: Any) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message
        response = payload.get("response")
        if isinstance(response, dict):
            error = response.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str) and message.strip():
                    return message
        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return message
    rendered = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return f"hermes response failed: {rendered[:500]}"


async def _iter_sse_events(response: httpx.Response) -> AsyncGenerator[tuple[str | None, str], None]:
    event_name: str | None = None
    data_lines: list[str] = []

    async for raw_line in response.aiter_lines():
        if raw_line == "":
            if data_lines:
                yield event_name, "\n".join(data_lines)
                event_name = None
                data_lines = []
            continue
        if raw_line.startswith(":"):
            continue
        if raw_line.startswith("event:"):
            event_name = raw_line[6:].strip() or None
            continue
        if raw_line.startswith("data:"):
            data = raw_line[5:]
            if data.startswith(" "):
                data = data[1:]
            data_lines.append(data)

    if data_lines:
        yield event_name, "\n".join(data_lines)


def _normalize_response_event(
    event_name: str | None,
    payload: Any,
    completed_tool_calls: set[str],
) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []

    resolved_event = event_name or str(payload.get("type") or "")

    if resolved_event == "response.output_text.delta":
        delta = payload.get("delta")
        return [{"kind": "text", "delta": delta}] if isinstance(delta, str) and delta else []

    if resolved_event in {"response.output_item.added", "response.output_item.done"}:
        item = payload.get("item")
        if not isinstance(item, dict):
            return []

        item_type = str(item.get("type") or "")
        if item_type == "function_call" and resolved_event == "response.output_item.added":
            tool_id = str(item.get("call_id") or item.get("id") or uuid.uuid4().hex)
            detail = item.get("arguments")
            if detail is not None and not isinstance(detail, str):
                detail = json.dumps(detail, ensure_ascii=False)
            return [
                {
                    "kind": "tool-start",
                    "id": tool_id,
                    "name": str(item.get("name") or "tool"),
                    "detail": detail,
                }
            ]

        if item_type == "function_call_output":
            tool_id = item.get("call_id")
            if not tool_id:
                return []
            tool_id = str(tool_id)
            if tool_id in completed_tool_calls:
                return []
            completed_tool_calls.add(tool_id)
            result = _flatten_response_output(item.get("output"))
            return [
                {
                    "kind": "tool-end",
                    "id": tool_id,
                    "status": _tool_result_status(result),
                    "result": result,
                }
            ]

    if resolved_event == "response.failed":
        raise RuntimeError(_extract_failed_response_message(payload))

    return []


class HermesEngine:
    def __init__(self, base_url: str, api_key: str, model: str = "hermes-agent"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def session_key(self, session_id: str) -> str:
        return f"silverretort:{session_id}"

    def _headers(self, session_id: str | None = None) -> dict[str, str]:
        headers = {"authorization": f"Bearer {self.api_key}"}
        if session_id:
            headers["X-Hermes-Session-Key"] = self.session_key(session_id)
        return headers

    async def _expand_slash(self, session_id: str, text: str) -> str:
        if not text.lstrip().startswith("/"):
            return text
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5)) as client:
                response = await client.post(
                    f"{self.base_url}/silverretort/slash/expand",
                    json={"text": text, "sessionKey": self.session_key(session_id)},
                    headers=self._headers(),
                )
                if response.status_code == 404:
                    return text
                response.raise_for_status()
                payload = response.json()
                if payload.get("handled") and isinstance(payload.get("expandedText"), str):
                    return payload["expandedText"]
        except Exception:
            return text
        return text

    async def list_slash_commands(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5)) as client:
            response = await client.get(
                f"{self.base_url}/silverretort/slash/commands",
                headers=self._headers(),
            )
            response.raise_for_status()
            payload = response.json()
            return list(payload.get("commands") or [])

    async def list_models(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as client:
            response = await client.get(
                f"{self.base_url}/silverretort/models",
                headers=self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())

    async def get_default_model(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5)) as client:
            response = await client.get(
                f"{self.base_url}/silverretort/default-model",
                headers=self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())

    async def set_default_model(self, provider: str, model: str, model_id: str | None = None) -> dict[str, Any]:
        body = {"provider": provider, "model": model}
        if model_id is not None:
            body["modelId"] = model_id
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as client:
            response = await client.put(
                f"{self.base_url}/silverretort/default-model",
                json=body,
                headers=self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())

    async def get_session_model(self, session_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=5)) as client:
            response = await client.get(
                f"{self.base_url}/silverretort/session-model",
                params={"sessionKey": self.session_key(session_id)},
                headers=self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())

    async def set_session_model(
        self,
        session_id: str,
        provider: str | None,
        model: str | None,
        model_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"sessionKey": self.session_key(session_id)}
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model
        if model_id is not None:
            body["modelId"] = model_id
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as client:
            response = await client.put(
                f"{self.base_url}/silverretort/session-model",
                json=body,
                headers=self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())

    async def run(
        self, session_id: str, workspace_id: str, history: list[Message], user_message: Message
    ) -> AsyncGenerator[dict[str, Any], None]:
        expanded_user_message = user_message
        original_text = _text_of(user_message)
        expanded_text = await self._expand_slash(session_id, original_text)
        if expanded_text != original_text:
            expanded_user_message = user_message.model_copy(deep=True)
            expanded_user_message.parts = [TextPart(text=expanded_text)]

        system = SYSTEM_PROMPT.format(
            session_id=session_id,
            workspace_id=workspace_id,
            ui_show_artifact_tool=UI_SHOW_ARTIFACT_TOOL,
            ui_update_artifact_tool=UI_UPDATE_ARTIFACT_TOOL,
            attachments_note=_attachments_note(history, user_message),
        )
        conversation_history = [_to_openai_message(m) for m in history if _text_of(m) or m.attachments]
        payload = {
            "model": self.model,
            "instructions": system,
            "conversation_history": conversation_history,
            "input": [_to_openai_message(expanded_user_message)],
            "stream": True,
            "workspace_id": workspace_id,
        }
        headers = self._headers(session_id)
        completed_tool_calls: set[str] = set()

        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/v1/responses",
                json=payload,
                headers=headers,
            ) as response:
                if response.status_code != 200:
                    body = (await response.aread()).decode("utf-8", "replace")[:500]
                    raise RuntimeError(f"hermes HTTP {response.status_code}: {body}")
                async for event_name, data in _iter_sse_events(response):
                    if data == "[DONE]":
                        return
                    try:
                        event_payload = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    for event in _normalize_response_event(
                        event_name,
                        event_payload,
                        completed_tool_calls,
                    ):
                        yield event
