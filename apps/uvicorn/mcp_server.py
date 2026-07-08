"""暴露给 hermes 的 MCP server（streamable HTTP，挂载在 /mcp）。

UI 工具：调用即落库 + 经 /api/events 广播给前端执行（桌面单用户，广播即可）。
文件工具：让 hermes（本地或远程沙盒）无需共享文件系统即可读取用户附件。
"""

import base64
import uuid
from typing import Any

from mcp.server.fastmcp import FastMCP

import db
import events
from models import Artifact

mcp = FastMCP("silverretort-ui", stateless_http=True, streamable_http_path="/")

# 前端启动时上报其 artifact 渲染器注册表（POST /api/render-types）
BUILTIN_RENDER_TYPES = ["iframe", "image", "markdown"]
_render_types: list[str] = list(BUILTIN_RENDER_TYPES)

# 文本附件直接返回内容的上限；更大的文件返回 base64 也受此限制
MAX_READ_BYTES = 5 * 1024 * 1024

TEXT_MIME_PREFIXES = ("text/",)
TEXT_MIME_EXACT = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/toml",
    "text/csv",
}


def set_render_types(types: list[str]) -> None:
    global _render_types
    _render_types = types or list(BUILTIN_RENDER_TYPES)


@mcp.tool()
def ui_show_artifact(
    session_id: str, type: str, title: str, payload: dict[str, Any] | None = None
) -> str:
    """在用户界面右侧面板展示内容。

    type 可通过 ui_list_render_types 查询；内置：
    - iframe: payload {"url": ...} 或 {"html": ...}
    - image: payload {"url": ...} 或 {"dataUri": ...}
    - markdown: payload {"text": ...}
    返回 artifact_id，可用于 ui_update_artifact 增量更新。
    """
    if db.get_session(session_id) is None:
        return f"error: session not found: {session_id}"
    artifact = Artifact(
        id=uuid.uuid4().hex,
        session_id=session_id,
        type=type,
        title=title,
        payload=payload,
        created_at=db.now_iso(),
    )
    db.upsert_artifact(artifact)
    events.broadcast(events.artifact_event(session_id, artifact.model_dump(by_alias=True)))
    events.broadcast(
        events.ui_command({"command": "show-artifact", "artifactId": artifact.id}, session_id)
    )
    return artifact.id


@mcp.tool()
def ui_update_artifact(artifact_id: str, payload: dict[str, Any]) -> str:
    """增量更新已展示的 artifact 内容（如刷新图表数据）。"""
    artifact = db.get_artifact(artifact_id)
    if artifact is None:
        return f"error: artifact not found: {artifact_id}"
    artifact.payload = payload
    db.upsert_artifact(artifact)
    events.broadcast(
        events.ui_command(
            {"command": "update-artifact", "artifactId": artifact_id, "payload": payload},
            artifact.session_id,
        )
    )
    return "ok"


@mcp.tool()
def ui_list_render_types() -> list[str]:
    """列出前端当前支持的 artifact 渲染类型。"""
    return list(_render_types)


@mcp.tool()
def list_user_files(session_id: str) -> list[dict[str, Any]]:
    """列出该会话中用户上传的附件（id/名称/类型/大小）。"""
    seen: dict[str, dict[str, Any]] = {}
    for message in db.list_messages(session_id):
        for attachment in message.attachments:
            seen[attachment.id] = attachment.model_dump(by_alias=True)
    return list(seen.values())


@mcp.tool()
def read_user_file(file_id: str) -> dict[str, Any]:
    """读取用户上传的附件内容。

    文本类返回 {"text": ...}；二进制返回 {"base64": ...}；超过 5MB 拒绝。
    """
    found = db.get_file(file_id)
    if found is None:
        return {"error": f"file not found: {file_id}"}
    attachment, path = found
    if attachment.size > MAX_READ_BYTES:
        return {"error": f"file too large ({attachment.size} bytes), max {MAX_READ_BYTES}"}
    data = open(path, "rb").read()
    mime = attachment.mime_type
    is_text = mime.startswith(TEXT_MIME_PREFIXES) or mime in TEXT_MIME_EXACT
    if is_text:
        try:
            return {"name": attachment.name, "mimeType": mime, "text": data.decode("utf-8")}
        except UnicodeDecodeError:
            pass
    return {
        "name": attachment.name,
        "mimeType": mime,
        "base64": base64.b64encode(data).decode("ascii"),
    }
