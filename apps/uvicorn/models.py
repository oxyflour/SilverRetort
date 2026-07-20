"""协议数据模型：与 packages/protocol 的 zod schema 一一对应，wire 格式为 camelCase。"""

from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Attachment(ApiModel):
    workspace_id: str
    relative_path: str
    name: str
    mime_type: str
    size: int
    kind: Literal["image", "file"]


class Workspace(ApiModel):
    id: str
    name: str
    template_id: str | None
    status: Literal["active", "creating", "deleting", "error"] = "active"
    connection_id: str = "local"
    switch_mode: Literal["local", "remote"] = "local"
    switch_url: str = ""
    has_hermes_api_key: bool = False
    created_at: str
    updated_at: str


class Session(ApiModel):
    id: str
    workspace_id: str
    title: str
    created_at: str
    updated_at: str


class MessageSearchHit(ApiModel):
    session_id: str
    message_id: str
    role: Literal["user", "assistant"]
    created_at: str
    snippet: str


class SessionMessageSearchResult(ApiModel):
    session_id: str
    total_hits: int
    hits: list[MessageSearchHit] = Field(default_factory=list)


class MessageSearchResponse(ApiModel):
    query: str
    results: list[SessionMessageSearchResult] = Field(default_factory=list)


class ToolCall(ApiModel):
    id: str
    name: str
    status: Literal["running", "done", "error"]
    detail: str | None = None
    result: str | None = None
    detail_truncated: bool = False
    result_truncated: bool = False


class TextPart(ApiModel):
    type: Literal["text"] = "text"
    text: str


class ToolPart(ApiModel):
    type: Literal["tool"] = "tool"
    tool_call: ToolCall


class ArtifactInputPart(ApiModel):
    type: Literal["artifact-input"] = "artifact-input"
    artifact_id: str
    submission_id: str
    action: str
    data: Any
    display_text: str | None = None


class ArtifactContextPart(ApiModel):
    type: Literal["artifact-context"] = "artifact-context"
    artifact_id: str
    revision: int
    action: str
    data: Any
    display_text: str | None = None


MessagePart = Union[TextPart, ToolPart, ArtifactInputPart, ArtifactContextPart]


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


class IframeArtifactPayload(ApiModel):
    path: str | None = None
    url: str | None = None
    workspace_port: dict[str, Any] | None = None


class CreateSessionRequest(ApiModel):
    title: str | None = None


class UpdateSessionRequest(ApiModel):
    title: str


class CreateWorkspaceRequest(ApiModel):
    name: str
    connection_id: str | None = None
    template_id: str | None = None


class WorkspaceTemplateSuggestion(ApiModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    label: str = Field(min_length=1, max_length=80)
    prompt: str = Field(min_length=1, max_length=2000)


class WorkspaceTemplateEmptyState(ApiModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    title: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=500)
    suggestions: list[WorkspaceTemplateSuggestion] = Field(min_length=1, max_length=6)


class WorkspaceTemplateUi(ApiModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    module: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")


class WorkspaceTemplateAgent(ApiModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )

    instructions: str = Field(min_length=1, max_length=20000)


class WorkspaceTemplate(ApiModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    version: Literal[1]
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=500)
    empty_state: WorkspaceTemplateEmptyState
    ui: WorkspaceTemplateUi
    agent: WorkspaceTemplateAgent | None = None


class UpdateWorkspaceRequest(ApiModel):
    name: str


class SwitchProfile(ApiModel):
    id: str
    name: str
    mode: Literal["local", "remote"]
    switch_url: str = ""
    has_hermes_api_key: bool = False


class CreateSwitchProfileRequest(ApiModel):
    name: str
    switch_url: str
    hermes_api_key: str


class UpdateSwitchProfileRequest(ApiModel):
    name: str
    switch_url: str
    hermes_api_key: str | None = None


class SlashCommand(ApiModel):
    command: str
    name: str
    description: str = ""
    kind: Literal["skill", "bundle"]


class HermesModel(ApiModel):
    id: str
    provider: str
    provider_label: str = ""
    model: str
    label: str = ""
    available: bool = True
    current: bool = False


class HermesModelsResponse(ApiModel):
    models: list[HermesModel] = Field(default_factory=list)
    default_provider: str = ""
    default_model: str = ""


class HermesUsageWindow(ApiModel):
    label: str
    used_percent: float | None = None
    reset_at: str | None = None
    detail: str | None = None


class HermesUsageResponse(ApiModel):
    available: bool = False
    percent: float | None = None
    label: str = ""
    title: str = ""
    provider: str = ""
    model: str = ""
    source: str = ""
    fetched_at: str = ""
    windows: list[HermesUsageWindow] = Field(default_factory=list)
    details: list[str] = Field(default_factory=list)
    unavailable_reason: str = ""


class HermesBackgroundProcess(ApiModel):
    session_id: str
    command: str = ""
    cwd: str | None = None
    pid: int | None = None
    started_at: str = ""
    uptime_seconds: int = 0
    status: Literal["running", "exited"] = "running"
    output_preview: str = ""
    exit_code: int | None = None
    session_scoped: bool = False
    watch_patterns: list[str] = Field(default_factory=list)
    watch_hit: bool = False
    notify_on_complete: bool = False
    detached: bool = False


class HermesAsyncDelegation(ApiModel):
    id: str
    goal: str = ""
    context: str = ""
    toolsets: list[str] = Field(default_factory=list)
    role: str = ""
    model: str = ""
    status: str = ""
    dispatched_at: float | None = None
    completed_at: float | None = None
    duration_seconds: float | None = None
    is_batch: bool = False
    task_count: int = 1


class HermesRuntimeResponse(ApiModel):
    busy: bool = False
    active_task_count: int = 0
    background_process_count: int = 0
    background_processes: list[HermesBackgroundProcess] = Field(default_factory=list)
    async_delegation_count: int = 0
    async_delegations: list[HermesAsyncDelegation] = Field(default_factory=list)


class SessionModel(ApiModel):
    session_key: str = ""
    source: Literal["default", "session"] = "default"
    provider: str = ""
    model: str = ""
    model_id: str = ""
    default_provider: str = ""
    default_model: str = ""
    base_url: str = ""
    has_api_key: bool = False


class SetModelRequest(ApiModel):
    model_id: str | None = None
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class ModelSetting(ApiModel):
    provider: str = ""
    model: str = ""
    model_id: str = ""
    inherited: bool = False
    base_url: str = ""
    has_api_key: bool = False


class SendChatRequest(ApiModel):
    text: str
    attachments: list[Attachment] = Field(default_factory=list)


class RestartMessageRequest(ApiModel):
    text: str


class SendChatResponse(ApiModel):
    run_id: str
    user_message_id: str
    assistant_message_id: str


class ArtifactContextUpdateRequest(ApiModel):
    action: str = Field(min_length=1, max_length=80)
    data: Any
    display_text: str | None = Field(default=None, min_length=1, max_length=500)


class ArtifactContext(ApiModel):
    artifact_id: str
    session_id: str
    revision: int
    action: str
    data: Any
    display_text: str | None = None
    updated_at: str
