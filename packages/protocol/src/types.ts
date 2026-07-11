import { z } from "zod";

// ---- 基础实体 ----

export const AttachmentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  relativePath: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(["image", "file"]),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "creating", "deleting", "error"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

const NullableStringSchema = z.string().nullish();

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["running", "done", "error"]),
  detail: NullableStringSchema,
  result: NullableStringSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool"), toolCall: ToolCallSchema }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(MessagePartSchema),
  attachments: z.array(AttachmentSchema).default([]),
  artifactIds: z.array(z.string()).default([]),
  status: z.enum(["streaming", "complete", "error", "stopped"]).default("complete"),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// type 为开放字符串：内置 iframe/image/markdown，图表、3D 等由前端注册表扩展
export const ArtifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(),
  title: z.string(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// ---- UI 命令（hermes 经 MCP 下发） ----

export const UiCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("show-artifact"), artifactId: z.string() }),
  z.object({
    command: z.literal("update-artifact"),
    artifactId: z.string(),
    payload: z.unknown(),
  }),
  z.object({ command: z.literal("set-panel"), open: z.boolean() }),
]);
export type UiCommand = z.infer<typeof UiCommandSchema>;

// ---- 事件流（/api/events，所有事件带 sessionId 以支持多会话并发路由） ----

const runBase = {
  sessionId: z.string(),
  runId: z.string(),
  messageId: z.string(),
};

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-started"), ...runBase }),
  z.object({ type: z.literal("text-delta"), ...runBase, delta: z.string() }),
  z.object({
    type: z.literal("tool-start"),
    ...runBase,
    toolCallId: z.string(),
    name: z.string(),
    detail: NullableStringSchema,
  }),
  z.object({
    type: z.literal("tool-end"),
    ...runBase,
    toolCallId: z.string(),
    status: z.enum(["done", "error"]),
    result: NullableStringSchema,
  }),
  z.object({
    type: z.literal("artifact"),
    sessionId: z.string(),
    runId: z.string().optional(),
    messageId: z.string().optional(),
    artifact: ArtifactSchema,
  }),
  z.object({ type: z.literal("done"), ...runBase }),
  z.object({ type: z.literal("error"), ...runBase, message: z.string() }),
  z.object({
    type: z.literal("ui-command"),
    sessionId: z.string().optional(),
    uiCommand: UiCommandSchema,
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

// ---- REST 请求/响应 ----

export const CreateSessionRequestSchema = z.object({
  title: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const UpdateSessionRequestSchema = z.object({
  title: z.string(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

export const CreateWorkspaceRequestSchema = z.object({ name: z.string() });
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = z.object({ name: z.string() });
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const WorkspaceCapabilitySchema = z.object({
  supported: z.boolean(),
  version: z.number(),
  writable: z.boolean(),
  cwdEnforced: z.boolean(),
});
export type WorkspaceCapability = z.infer<typeof WorkspaceCapabilitySchema>;

export const SendChatRequestSchema = z.object({
  text: z.string(),
  attachmentIds: z.array(z.string()).default([]),
});
export type SendChatRequest = z.infer<typeof SendChatRequestSchema>;

export const RestartMessageRequestSchema = z.object({
  text: z.string(),
});
export type RestartMessageRequest = z.infer<typeof RestartMessageRequestSchema>;

export const SendChatResponseSchema = z.object({
  runId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string(),
});
export type SendChatResponse = z.infer<typeof SendChatResponseSchema>;
