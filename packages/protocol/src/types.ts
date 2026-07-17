import { z } from "zod";

// ---- 基础实体 ----

export const AttachmentSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  kind: z.enum(["image", "file"]),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const WorkspaceFileSchema = AttachmentSchema;
export type WorkspaceFile = Attachment;

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "URL must use http or https");

export const IframeArtifactPayloadSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ url: HttpUrlSchema }).strict(),
]);
export type IframeArtifactPayload = z.infer<typeof IframeArtifactPayloadSchema>;

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
  detailTruncated: z.boolean().optional(),
  resultTruncated: z.boolean().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const MessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool"), toolCall: ToolCallSchema }),
  z.object({
    type: z.literal("artifact-input"),
    artifactId: z.string(),
    submissionId: z.string(),
    action: z.string(),
    data: JsonValueSchema,
    displayText: z.string().optional(),
  }),
  z.object({
    type: z.literal("artifact-context"),
    artifactId: z.string(),
    revision: z.number().int().positive(),
    action: z.string(),
    data: JsonValueSchema,
    displayText: z.string().optional(),
  }),
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

export const ArtifactContextSchema = z.object({
  artifactId: z.string(),
  sessionId: z.string(),
  revision: z.number().int().positive(),
  action: z.string(),
  data: JsonValueSchema,
  displayText: z.string().optional(),
  updatedAt: z.string(),
});
export type ArtifactContext = z.infer<typeof ArtifactContextSchema>;

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
  z.object({
    type: z.literal("user-message"),
    sessionId: z.string(),
    message: MessageSchema,
  }),
  z.object({
    type: z.literal("artifact-context"),
    sessionId: z.string(),
    artifactId: z.string(),
    context: ArtifactContextSchema.nullable(),
  }),
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

export const SlashCommandSchema = z.object({
  command: z.string(),
  name: z.string(),
  description: z.string().default(""),
  kind: z.enum(["skill", "bundle"]),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

export const HermesModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerLabel: z.string().default(""),
  model: z.string(),
  label: z.string().default(""),
  available: z.boolean().default(true),
  current: z.boolean().default(false),
});
export type HermesModel = z.infer<typeof HermesModelSchema>;

export const HermesModelsResponseSchema = z.object({
  models: z.array(HermesModelSchema).default([]),
  defaultProvider: z.string().default(""),
  defaultModel: z.string().default(""),
});
export type HermesModelsResponse = z.infer<typeof HermesModelsResponseSchema>;

export const HermesUsageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number().nullable().default(null),
  resetAt: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
});
export type HermesUsageWindow = z.infer<typeof HermesUsageWindowSchema>;

export const HermesUsageResponseSchema = z.object({
  available: z.boolean().default(false),
  percent: z.number().nullable().default(null),
  label: z.string().default(""),
  title: z.string().default(""),
  provider: z.string().default(""),
  model: z.string().default(""),
  source: z.string().default(""),
  fetchedAt: z.string().default(""),
  windows: z.array(HermesUsageWindowSchema).default([]),
  details: z.array(z.string()).default([]),
  unavailableReason: z.string().default(""),
});
export type HermesUsageResponse = z.infer<typeof HermesUsageResponseSchema>;

export const SessionModelSchema = z.object({
  sessionKey: z.string().default(""),
  source: z.enum(["default", "session"]).default("default"),
  provider: z.string().default(""),
  model: z.string().default(""),
  modelId: z.string().default(""),
  defaultProvider: z.string().default(""),
  defaultModel: z.string().default(""),
  baseUrl: z.string().default(""),
  hasApiKey: z.boolean().default(false),
});
export type SessionModel = z.infer<typeof SessionModelSchema>;

export const SetModelRequestSchema = z.object({
  modelId: z.string().nullish(),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  baseUrl: z.string().nullish(),
  apiKey: z.string().nullish(),
});
export type SetModelRequest = z.infer<typeof SetModelRequestSchema>;

export const SendChatRequestSchema = z.object({
  text: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
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

export const ArtifactContextMessageSchema = z.object({
  type: z.literal("silverretort.artifact.context"),
  version: z.literal(1),
  requestId: z.string().min(1).max(100),
  action: z.string().trim().min(1).max(80),
  data: JsonValueSchema,
  displayText: z.string().trim().min(1).max(500).optional(),
});
export type ArtifactContextMessage = z.infer<typeof ArtifactContextMessageSchema>;

export const ArtifactContextUpdateRequestSchema = ArtifactContextMessageSchema.pick({
  action: true,
  data: true,
  displayText: true,
});
export type ArtifactContextUpdateRequest = z.infer<typeof ArtifactContextUpdateRequestSchema>;
