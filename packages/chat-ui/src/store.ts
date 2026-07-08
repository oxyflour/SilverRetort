import { create } from "zustand";
import {
  ApiClient,
  Artifact,
  Attachment,
  ChatEvent,
  Message,
  Session,
  ToolCall,
} from "silverretort-protocol";

/** 每个 session 一个桶：消息与运行状态和"当前显示哪个 session"解耦，支持多会话并发 */
export interface SessionBucket {
  messages: Message[];
  runId: string | null;
  loaded: boolean;
  error: string | null;
}

export interface PanelState {
  open: boolean;
  activeArtifactId: string | null;
}

interface ChatState {
  client: ApiClient;
  sessions: Session[];
  currentSessionId: string | null;
  buckets: Record<string, SessionBucket>;
  artifacts: Record<string, Artifact>;
  /** 每 session 的 artifact id 顺序表 */
  artifactOrder: Record<string, string[]>;
  panel: PanelState;
  /** 输入框待发送附件（仅当前 session 视图用） */
  pendingAttachments: Attachment[];

  refreshSessions: () => Promise<void>;
  createSession: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  stopRun: (sessionId: string) => Promise<void>;
  addAttachment: (file: File) => Promise<void>;
  removeAttachment: (id: string) => void;
  openArtifact: (id: string) => void;
  setPanelOpen: (open: boolean) => void;
  applyEvent: (event: ChatEvent) => void;
  /** 事件通道(重)连成功后补齐当前 session 数据 */
  resyncCurrent: () => Promise<void>;
}

const emptyBucket = (): SessionBucket => ({
  messages: [],
  runId: null,
  loaded: false,
  error: null,
});

function updateMessage(
  bucket: SessionBucket,
  messageId: string,
  fn: (message: Message) => Message,
): SessionBucket {
  return {
    ...bucket,
    messages: bucket.messages.map((m) => (m.id === messageId ? fn(m) : m)),
  };
}

/** run-started 前端兜底：若目标 assistant 消息还不存在则补一个占位 */
function ensureAssistantMessage(
  bucket: SessionBucket,
  sessionId: string,
  messageId: string,
): SessionBucket {
  if (bucket.messages.some((m) => m.id === messageId)) return bucket;
  const placeholder: Message = {
    id: messageId,
    sessionId,
    role: "assistant",
    parts: [],
    attachments: [],
    artifactIds: [],
    status: "streaming",
    createdAt: new Date().toISOString(),
  };
  return { ...bucket, messages: [...bucket.messages, placeholder] };
}

export const useChatStore = create<ChatState>((set, get) => {
  const withBucket = (
    sessionId: string,
    fn: (bucket: SessionBucket) => SessionBucket,
  ) => {
    set((state) => ({
      buckets: {
        ...state.buckets,
        [sessionId]: fn(state.buckets[sessionId] ?? emptyBucket()),
      },
    }));
  };

  const touchSession = (sessionId: string) => {
    set((state) => ({
      sessions: state.sessions
        .map((s) =>
          s.id === sessionId ? { ...s, updatedAt: new Date().toISOString() } : s,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
  };

  return {
    client: new ApiClient(),
    sessions: [],
    currentSessionId: null,
    buckets: {},
    artifacts: {},
    artifactOrder: {},
    panel: { open: false, activeArtifactId: null },
    pendingAttachments: [],

    refreshSessions: async () => {
      const sessions = await get().client.listSessions();
      set({ sessions });
      if (!get().currentSessionId && sessions.length > 0) {
        await get().selectSession(sessions[0].id);
      }
    },

    createSession: async () => {
      const session = await get().client.createSession();
      set((state) => ({ sessions: [session, ...state.sessions] }));
      await get().selectSession(session.id);
    },

    selectSession: async (id) => {
      set({ currentSessionId: id, pendingAttachments: [] });
      const bucket = get().buckets[id];
      if (bucket?.loaded) return;
      const [messages, artifacts] = await Promise.all([
        get().client.listMessages(id),
        get().client.listArtifacts(id),
      ]);
      withBucket(id, (b) => ({ ...b, messages, loaded: true }));
      set((state) => ({
        artifacts: {
          ...state.artifacts,
          ...Object.fromEntries(artifacts.map((a) => [a.id, a])),
        },
        artifactOrder: { ...state.artifactOrder, [id]: artifacts.map((a) => a.id) },
      }));
    },

    renameSession: async (id, title) => {
      const session = await get().client.renameSession(id, title);
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? session : s)),
      }));
    },

    deleteSession: async (id) => {
      await get().client.deleteSession(id);
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== id);
        const { [id]: _removed, ...buckets } = state.buckets;
        return {
          sessions,
          buckets,
          currentSessionId:
            state.currentSessionId === id
              ? (sessions[0]?.id ?? null)
              : state.currentSessionId,
        };
      });
    },

    sendMessage: async (text) => {
      const sessionId = get().currentSessionId;
      if (!sessionId) return;
      const attachments = get().pendingAttachments;
      set({ pendingAttachments: [] });
      const res = await get().client.sendChat(sessionId, {
        text,
        attachmentIds: attachments.map((a) => a.id),
      });
      const now = new Date().toISOString();
      withBucket(sessionId, (bucket) => ({
        ...bucket,
        runId: res.runId,
        error: null,
        messages: [
          ...bucket.messages,
          {
            id: res.userMessageId,
            sessionId,
            role: "user" as const,
            parts: [{ type: "text" as const, text }],
            attachments,
            artifactIds: [],
            status: "complete" as const,
            createdAt: now,
          },
          {
            id: res.assistantMessageId,
            sessionId,
            role: "assistant" as const,
            parts: [],
            attachments: [],
            artifactIds: [],
            status: "streaming" as const,
            createdAt: now,
          },
        ],
      }));
      touchSession(sessionId);
    },

    stopRun: async (sessionId) => {
      await get().client.stopRun(sessionId);
    },

    addAttachment: async (file) => {
      const attachment = await get().client.uploadFile(file);
      set((state) => ({
        pendingAttachments: [...state.pendingAttachments, attachment],
      }));
    },

    removeAttachment: (id) => {
      set((state) => ({
        pendingAttachments: state.pendingAttachments.filter((a) => a.id !== id),
      }));
    },

    openArtifact: (id) => {
      set({ panel: { open: true, activeArtifactId: id } });
    },

    setPanelOpen: (open) => {
      set((state) => ({ panel: { ...state.panel, open } }));
    },

    resyncCurrent: async () => {
      const id = get().currentSessionId;
      if (!id) return;
      const messages = await get().client.listMessages(id);
      withBucket(id, (b) => ({ ...b, messages, loaded: true }));
    },

    applyEvent: (event) => {
      switch (event.type) {
        case "run-started":
          withBucket(event.sessionId, (bucket) => ({
            ...ensureAssistantMessage(bucket, event.sessionId, event.messageId),
            runId: event.runId,
            error: null,
          }));
          break;

        case "text-delta":
          withBucket(event.sessionId, (bucket) =>
            updateMessage(
              ensureAssistantMessage(bucket, event.sessionId, event.messageId),
              event.messageId,
              (m) => {
                const parts = [...m.parts];
                const last = parts[parts.length - 1];
                if (last?.type === "text") {
                  parts[parts.length - 1] = { type: "text", text: last.text + event.delta };
                } else {
                  parts.push({ type: "text", text: event.delta });
                }
                return { ...m, parts };
              },
            ),
          );
          break;

        case "tool-start":
          withBucket(event.sessionId, (bucket) =>
            updateMessage(
              ensureAssistantMessage(bucket, event.sessionId, event.messageId),
              event.messageId,
              (m) => ({
                ...m,
                parts: [
                  ...m.parts,
                  {
                    type: "tool",
                    toolCall: {
                      id: event.toolCallId,
                      name: event.name,
                      status: "running",
                      detail: event.detail,
                    },
                  },
                ],
              }),
            ),
          );
          break;

        case "tool-end":
          withBucket(event.sessionId, (bucket) =>
            updateMessage(bucket, event.messageId, (m) => ({
              ...m,
              parts: m.parts.map((p) =>
                p.type === "tool" && p.toolCall.id === event.toolCallId
                  ? {
                      ...p,
                      toolCall: {
                        ...p.toolCall,
                        status: event.status,
                        result: event.result,
                      } satisfies ToolCall,
                    }
                  : p,
              ),
            })),
          );
          break;

        case "artifact": {
          set((state) => ({
            artifacts: { ...state.artifacts, [event.artifact.id]: event.artifact },
            artifactOrder: {
              ...state.artifactOrder,
              [event.sessionId]: [
                ...(state.artifactOrder[event.sessionId] ?? []).filter(
                  (id) => id !== event.artifact.id,
                ),
                event.artifact.id,
              ],
            },
          }));
          const messageId = event.messageId;
          if (messageId) {
            withBucket(event.sessionId, (bucket) =>
              updateMessage(bucket, messageId, (m) => ({
                ...m,
                artifactIds: m.artifactIds.includes(event.artifact.id)
                  ? m.artifactIds
                  : [...m.artifactIds, event.artifact.id],
              })),
            );
          }
          // 当前会话产出的 artifact 自动在右栏打开
          if (event.sessionId === get().currentSessionId) {
            set({ panel: { open: true, activeArtifactId: event.artifact.id } });
          }
          break;
        }

        case "done":
          withBucket(event.sessionId, (bucket) => ({
            ...updateMessage(bucket, event.messageId, (m) => ({
              ...m,
              status: "complete",
            })),
            runId: null,
          }));
          touchSession(event.sessionId);
          // 服务端可能已自动生成会话标题，静默同步列表
          void get()
            .client.listSessions()
            .then((sessions) => set({ sessions }));
          break;

        case "error":
          withBucket(event.sessionId, (bucket) => ({
            ...updateMessage(bucket, event.messageId, (m) => ({
              ...m,
              status: "error",
            })),
            runId: null,
            error: event.message,
          }));
          break;

        case "ui-command": {
          const cmd = event.uiCommand;
          if (cmd.command === "show-artifact") {
            set({ panel: { open: true, activeArtifactId: cmd.artifactId } });
          } else if (cmd.command === "update-artifact") {
            set((state) => {
              const artifact = state.artifacts[cmd.artifactId];
              if (!artifact) return state;
              return {
                artifacts: {
                  ...state.artifacts,
                  [cmd.artifactId]: { ...artifact, payload: cmd.payload },
                },
              };
            });
          } else if (cmd.command === "set-panel") {
            set((state) => ({ panel: { ...state.panel, open: cmd.open } }));
          }
          break;
        }
      }
    },
  };
});
