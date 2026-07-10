"""协议数据模型：与 packages/protocol 的 zod schema 一一对应，wire 格式为 camelCase。"""

from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Attachment(ApiModel):
    id: str
    name: str
    mime_type: str
    size: int
    kind: Literal["image", "file"]


class Session(ApiModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class ToolCall(ApiModel):
    id: str
    name: str
    status: Literal["running", "done", "error"]
    detail: str | None = None
    result: str | None = None


class TextPart(ApiModel):
    type: Literal["text"] = "text"
    text: str


class ToolPart(ApiModel):
    type: Literal["tool"] = "tool"
    tool_call: ToolCall


MessagePart = Union[TextPart, ToolPart]


class Message(ApiModel):
    id: str
    session_id: str
    role: Literal["user", "assistant"]
    parts: list[MessagePart] = Field(default_factory=list)
    attachments: list[Attachment] = Field(default_factory=list)
    artifact_ids: list[str] = Field(default_factory=list)
    status: Literal["streaming", "complete", "error", "stopped"] = "complete"
    created_at: str


class Artifact(ApiModel):
    id: str
    session_id: str
    type: str
    title: str
    payload: Any = None
    created_at: str


class CreateSessionRequest(ApiModel):
    title: str | None = None


class UpdateSessionRequest(ApiModel):
    title: str


class SendChatRequest(ApiModel):
    text: str
    attachment_ids: list[str] = Field(default_factory=list)


class RestartMessageRequest(ApiModel):
    text: str


class SendChatResponse(ApiModel):
    run_id: str
    user_message_id: str
    assistant_message_id: str
