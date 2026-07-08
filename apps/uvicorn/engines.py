"""Agent 引擎接口与 mock 实现。

引擎产出内部事件 dict（kind: text / tool-start / tool-end / artifact），
由 runs.py 负责落库与广播。hermes 引擎见 hermes_client.py。
"""

import asyncio
import os
import uuid
from typing import Any, AsyncGenerator, Protocol

from models import Message


class Engine(Protocol):
    def run(
        self, session_id: str, history: list[Message], user_message: Message
    ) -> AsyncGenerator[dict[str, Any], None]: ...


class MockEngine:
    """开发/兜底引擎：回显 + 假工具事件；输入含 artifact 时产出示例 artifact。"""

    async def run(
        self, session_id: str, history: list[Message], user_message: Message
    ) -> AsyncGenerator[dict[str, Any], None]:
        user_text = next((p.text for p in user_message.parts if p.type == "text"), "")

        tool_id = uuid.uuid4().hex
        yield {"kind": "tool-start", "id": tool_id, "name": "mock_think", "detail": "思考中"}
        await asyncio.sleep(0.4)
        yield {"kind": "tool-end", "id": tool_id, "status": "done", "result": f"收到 {len(history)} 条历史消息"}

        reply = f"（mock 引擎）你说的是：{user_text}"
        for char in reply:
            await asyncio.sleep(0.02)
            yield {"kind": "text", "delta": char}

        if "artifact" in user_text.lower():
            yield {
                "kind": "artifact",
                "type": "markdown",
                "title": "示例 Artifact",
                "payload": {"text": f"# 示例\n\n由 mock 引擎生成。\n\n> {user_text}"},
            }
            yield {"kind": "text", "delta": "\n\n已生成一个示例 artifact，见右侧面板。"}


def create_engine() -> Engine:
    """按环境选择引擎：配置了 HERMES_URL 用 hermes，否则 mock 兜底。"""
    hermes_url = os.getenv("HERMES_URL")
    if hermes_url:
        from hermes_client import HermesEngine

        return HermesEngine(
            base_url=hermes_url,
            api_key=os.getenv("HERMES_API_KEY", ""),
            model=os.getenv("HERMES_MODEL", "hermes-agent"),
        )
    return MockEngine()
