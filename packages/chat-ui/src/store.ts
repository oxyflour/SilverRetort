import { create } from "zustand";
import {
  ApiClient,
  Artifact,
  Attachment,
  ChatEvent,
  Message,
  Session,
  ToolCall,
  Workspace,
  WorkspaceCapability,
} from "silverretort-protocol";

export interface SessionBucket {
  messages: Message[];
  runId: string | null;
  loaded: boolean;
  error: string | null;
}

export interface ArtifactWorkspaceState {
  open: boolean;
  activeArtifactId: string | null;
  tabIds: string[];
}

interface ChatState {
  client: ApiClient;
  workspaces: Workspace[];
  workspaceCapability: WorkspaceCapability | null;
  currentWorkspaceId: string | null;
  collapsedWorkspaceIds: string[];
  sessions: Session[];
  currentSessionId: string | null;
  buckets: Record<string, SessionBucket>;
  artifacts: Record<string, Artifact>;
  artifactWorkspaces: Record<string, ArtifactWorkspaceState>;
  pendingAttachments: Attachment[];

  refreshSessions: () => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  selectWorkspace: (id: string) => void;
  toggleWorkspace: (id: string) => void;
  createSession: (workspaceId?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  restartFromMessage: (messageId: string, text: string) => Promise<void>;
  stopRun: (sessionId: string) => Promise<void>;
  addAttachment: (file: File) => Promise<void>;
  removeAttachment: (workspaceId: string, relativePath: string) => void;
  openArtifact: (id: string, sessionId?: string) => void;
  closeArtifact: (id: string) => void;
  setPanelOpen: (open: boolean) => void;
  applyEvent: (event: ChatEvent) => void;
  resyncCurrent: () => Promise<void>;
}

const emptyBucket = (): SessionBucket => ({
  messages: [],
  runId: null,
  loaded: false,
  error: null,
});

const emptyArtifactWorkspace = (): ArtifactWorkspaceState => ({
  open: false,
  activeArtifactId: null,
  tabIds: [],
});

function updateMessage(
  bucket: SessionBucket,
  messageId: string,
  fn: (message: Message) => Message,
): SessionBucket {
  return {
    ...bucket,
    messages: bucket.messages.map((message) =>
      message.id === messageId ? fn(message) : message,
    ),
  };
}

function ensureAssistantMessage(
  bucket: SessionBucket,
  sessionId: string,
  messageId: string,
): SessionBucket {
  if (bucket.messages.some((message) => message.id === messageId)) {
    return bucket;
  }
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

function appendSentMessages(
  bucket: SessionBucket,
  userMessage: Message,
  assistantMessage: Message,
): SessionBucket {
  const existingUser = bucket.messages.find(
    (message) => message.id === userMessage.id,
  );
  const existingAssistant = bucket.messages.find(
    (message) => message.id === assistantMessage.id,
  );
  const remainingMessages = bucket.messages.filter(
    (message) =>
      message.id !== userMessage.id && message.id !== assistantMessage.id,
  );

  return {
    ...bucket,
    messages: [
      ...remainingMessages,
      { ...userMessage, ...existingUser },
      { ...assistantMessage, ...existingAssistant },
    ],
  };
}

function normalizeArtifactWorkspace(
  workspace: ArtifactWorkspaceState,
): ArtifactWorkspaceState {
  const { tabIds } = workspace;
  if (tabIds.length === 0) {
    return emptyArtifactWorkspace();
  }
  const activeArtifactId =
    workspace.activeArtifactId && tabIds.includes(workspace.activeArtifactId)
      ? workspace.activeArtifactId
      : tabIds[tabIds.length - 1];
  return {
    open: workspace.open,
    activeArtifactId,
    tabIds,
  };
}

function openArtifactInWorkspace(
  workspace: ArtifactWorkspaceState,
  artifactId: string,
): ArtifactWorkspaceState {
  const tabIds = workspace.tabIds.includes(artifactId)
    ? workspace.tabIds
    : [...workspace.tabIds, artifactId];
  return normalizeArtifactWorkspace({
    open: true,
    activeArtifactId: artifactId,
    tabIds,
  });
}

function closeArtifactInWorkspace(
  workspace: ArtifactWorkspaceState,
  artifactId: string,
): ArtifactWorkspaceState {
  const currentIndex = workspace.tabIds.indexOf(artifactId);
  if (currentIndex === -1) {
    return normalizeArtifactWorkspace(workspace);
  }

  const tabIds = workspace.tabIds.filter((id) => id !== artifactId);
  if (tabIds.length === 0) {
    return emptyArtifactWorkspace();
  }

  if (workspace.activeArtifactId !== artifactId) {
    return normalizeArtifactWorkspace({ ...workspace, tabIds });
  }

  const nextIndex = Math.min(currentIndex, tabIds.length - 1);
  return normalizeArtifactWorkspace({
    open: workspace.open,
    activeArtifactId: tabIds[nextIndex] ?? null,
    tabIds,
  });
}

function setWorkspaceOpen(
  workspace: ArtifactWorkspaceState,
  open: boolean,
): ArtifactWorkspaceState {
  const normalized = normalizeArtifactWorkspace(workspace);
  if (normalized.tabIds.length === 0) {
    return normalized;
  }
  return { ...normalized, open };
}

function replaceSessionArtifacts(
  currentArtifacts: Record<string, Artifact>,
  sessionId: string,
  nextArtifacts: Artifact[],
): Record<string, Artifact> {
  return {
    ...Object.fromEntries(
      Object.entries(currentArtifacts).filter(
        ([, artifact]) => artifact.sessionId !== sessionId,
      ),
    ),
    ...Object.fromEntries(
      nextArtifacts.map((artifact) => [artifact.id, artifact]),
    ),
  };
}

function removeArtifacts(
  currentArtifacts: Record<string, Artifact>,
  artifactIds: Set<string>,
): Record<string, Artifact> {
  if (artifactIds.size === 0) {
    return currentArtifacts;
  }
  return Object.fromEntries(
    Object.entries(currentArtifacts).filter(
      ([artifactId]) => !artifactIds.has(artifactId),
    ),
  );
}

function removeWorkspaceArtifacts(
  workspace: ArtifactWorkspaceState,
  artifactIds: Set<string>,
): ArtifactWorkspaceState {
  if (artifactIds.size === 0) {
    return normalizeArtifactWorkspace(workspace);
  }
  return normalizeArtifactWorkspace({
    ...workspace,
    activeArtifactId:
      workspace.activeArtifactId && artifactIds.has(workspace.activeArtifactId)
        ? null
        : workspace.activeArtifactId,
    tabIds: workspace.tabIds.filter((id) => !artifactIds.has(id)),
  });
}

function keepWorkspaceArtifacts(
  workspace: ArtifactWorkspaceState,
  validArtifactIds: Set<string>,
): ArtifactWorkspaceState {
  return normalizeArtifactWorkspace({
    ...workspace,
    activeArtifactId:
      workspace.activeArtifactId &&
      validArtifactIds.has(workspace.activeArtifactId)
        ? workspace.activeArtifactId
        : null,
    tabIds: workspace.tabIds.filter((id) => validArtifactIds.has(id)),
  });
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

  const withArtifactWorkspace = (
    sessionId: string,
    fn: (workspace: ArtifactWorkspaceState) => ArtifactWorkspaceState,
  ) => {
    set((state) => ({
      artifactWorkspaces: {
        ...state.artifactWorkspaces,
        [sessionId]: fn(
          state.artifactWorkspaces[sessionId] ?? emptyArtifactWorkspace(),
        ),
      },
    }));
  };

  const touchSession = (sessionId: string) => {
    set((state) => ({
      sessions: state.sessions
        .map((session) =>
          session.id === sessionId
            ? { ...session, updatedAt: new Date().toISOString() }
            : session,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }));
  };

  return {
    client: new ApiClient(),
    workspaces: [],
    workspaceCapability: null,
    currentWorkspaceId: null,
    collapsedWorkspaceIds: [],
    sessions: [],
    currentSessionId: null,
    buckets: {},
    artifacts: {},
    artifactWorkspaces: {},
    pendingAttachments: [],

    refreshSessions: async () => {
      const [workspaces, capability, sessions] = await Promise.all([
        get().client.listWorkspaces(),
        get().client.workspaceCapability(),
        get().client.listSessions(),
      ]);
      const currentWorkspaceId = get().currentWorkspaceId ?? workspaces[0]?.id ?? null;
      set({ workspaces, workspaceCapability: capability, sessions, currentWorkspaceId });
      if (!get().currentSessionId && sessions.length > 0) {
        const first = sessions.find((session) => session.workspaceId === currentWorkspaceId) ?? sessions[0];
        await get().selectSession(first.id);
      }
    },

    createWorkspace: async (name) => {
      const workspace = await get().client.createWorkspace(name);
      set((state) => ({
        workspaces: [workspace, ...state.workspaces],
        currentWorkspaceId: workspace.id,
        collapsedWorkspaceIds: state.collapsedWorkspaceIds.filter((id) => id !== workspace.id),
      }));
      await get().createSession(workspace.id);
    },

    renameWorkspace: async (id, name) => {
      const workspace = await get().client.renameWorkspace(id, name);
      set((state) => ({ workspaces: state.workspaces.map((item) => item.id === id ? workspace : item) }));
    },

    deleteWorkspace: async (id) => {
      await get().client.deleteWorkspace(id);
      const removedIds = new Set(get().sessions.filter((session) => session.workspaceId === id).map((session) => session.id));
      set((state) => {
        const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
        const sessions = state.sessions.filter((session) => !removedIds.has(session.id));
        return {
          workspaces,
          sessions,
          currentWorkspaceId: workspaces[0]?.id ?? null,
          currentSessionId: sessions[0]?.id ?? null,
          buckets: Object.fromEntries(Object.entries(state.buckets).filter(([key]) => !removedIds.has(key))),
          artifactWorkspaces: Object.fromEntries(Object.entries(state.artifactWorkspaces).filter(([key]) => !removedIds.has(key))),
          artifacts: Object.fromEntries(Object.entries(state.artifacts).filter(([, artifact]) => !removedIds.has(artifact.sessionId))),
          pendingAttachments: [],
        };
      });
      await get().refreshSessions();
    },

    selectWorkspace: (id) => set({ currentWorkspaceId: id }),
    toggleWorkspace: (id) => set((state) => ({
      collapsedWorkspaceIds: state.collapsedWorkspaceIds.includes(id)
        ? state.collapsedWorkspaceIds.filter((item) => item !== id)
        : [...state.collapsedWorkspaceIds, id],
    })),

    createSession: async (requestedWorkspaceId) => {
      const workspaceId = requestedWorkspaceId ?? get().currentWorkspaceId;
      if (!workspaceId) return;
      const session = await get().client.createSession(workspaceId);
      set((state) => ({ sessions: [session, ...state.sessions] }));
      await get().selectSession(session.id);
    },

    selectSession: async (id) => {
      const session = get().sessions.find((item) => item.id === id);
      set({ currentSessionId: id, currentWorkspaceId: session?.workspaceId ?? get().currentWorkspaceId, pendingAttachments: [] });
      const bucket = get().buckets[id];
      if (bucket?.loaded) {
        return;
      }
      const [messages, artifacts] = await Promise.all([
        get().client.listMessages(id),
        get().client.listArtifacts(id),
      ]);
      withBucket(id, (currentBucket) => ({
        ...currentBucket,
        messages,
        loaded: true,
      }));
      set((state) => ({
        artifacts: replaceSessionArtifacts(state.artifacts, id, artifacts),
      }));
    },

    renameSession: async (id, title) => {
      const session = await get().client.renameSession(id, title);
      set((state) => ({
        sessions: state.sessions.map((currentSession) =>
          currentSession.id === id ? session : currentSession,
        ),
      }));
    },

    deleteSession: async (id) => {
      await get().client.deleteSession(id);
      set((state) => {
        const sessions = state.sessions.filter((session) => session.id !== id);
        const { [id]: _removedBucket, ...buckets } = state.buckets;
        const { [id]: _removedWorkspace, ...artifactWorkspaces } =
          state.artifactWorkspaces;
        return {
          sessions,
          buckets,
          artifacts: replaceSessionArtifacts(state.artifacts, id, []),
          artifactWorkspaces,
          currentSessionId:
            state.currentSessionId === id
              ? (sessions[0]?.id ?? null)
              : state.currentSessionId,
          pendingAttachments:
            state.currentSessionId === id ? [] : state.pendingAttachments,
        };
      });
    },

    sendMessage: async (text) => {
      const sessionId = get().currentSessionId;
      if (!sessionId) {
        return;
      }
      const attachments = get().pendingAttachments;
      set({ pendingAttachments: [] });
      const response = await get().client.sendChat(sessionId, {
        text,
        attachments,
      });
      const now = new Date().toISOString();
      withBucket(sessionId, (bucket) => ({
        ...appendSentMessages(
          bucket,
          {
            id: response.userMessageId,
            sessionId,
            role: "user",
            parts: [{ type: "text", text }],
            attachments,
            artifactIds: [],
            status: "complete",
            createdAt: now,
          },
          {
            id: response.assistantMessageId,
            sessionId,
            role: "assistant",
            parts: [],
            attachments: [],
            artifactIds: [],
            status: "streaming",
            createdAt: now,
          },
        ),
        runId: response.runId,
        error: null,
      }));
      touchSession(sessionId);
    },

    restartFromMessage: async (messageId, text) => {
      const sessionId = get().currentSessionId;
      if (!sessionId) {
        return;
      }
      const bucket = get().buckets[sessionId];
      if (!bucket) {
        return;
      }

      const targetIndex = bucket.messages.findIndex(
        (message) => message.id === messageId,
      );
      if (targetIndex === -1) {
        return;
      }

      const response = await get().client.restartFromMessage(sessionId, messageId, {
        text,
      });

      const now = new Date().toISOString();
      const nextMessages: Message[] = bucket.messages
        .slice(0, targetIndex + 1)
        .map((message) =>
          message.id === response.userMessageId
            ? ({
                ...message,
                parts: [{ type: "text", text }],
                artifactIds: [],
                status: "complete",
              } satisfies Message)
            : message,
        );
      const assistantMessage: Message = {
        id: response.assistantMessageId,
        sessionId,
        role: "assistant",
        parts: [],
        attachments: [],
        artifactIds: [],
        status: "streaming",
        createdAt: now,
      };
      const removedArtifactIds = new Set(
        bucket.messages
          .slice(targetIndex + 1)
          .flatMap((message) => message.artifactIds),
      );

      set((state) => ({
        buckets: {
          ...state.buckets,
          [sessionId]: {
            ...(state.buckets[sessionId] ?? bucket),
            messages: [...nextMessages, assistantMessage],
            runId: response.runId,
            error: null,
            loaded: true,
          },
        },
        artifacts: removeArtifacts(state.artifacts, removedArtifactIds),
        artifactWorkspaces: {
          ...state.artifactWorkspaces,
          [sessionId]: removeWorkspaceArtifacts(
            state.artifactWorkspaces[sessionId] ?? emptyArtifactWorkspace(),
            removedArtifactIds,
          ),
        },
      }));
      touchSession(sessionId);

      try {
        const artifacts = await get().client.listArtifacts(sessionId);
        const validArtifactIds = new Set(
          artifacts.map((artifact) => artifact.id),
        );
        set((state) => ({
          artifacts: replaceSessionArtifacts(state.artifacts, sessionId, artifacts),
          artifactWorkspaces: {
            ...state.artifactWorkspaces,
            [sessionId]: keepWorkspaceArtifacts(
              state.artifactWorkspaces[sessionId] ?? emptyArtifactWorkspace(),
              validArtifactIds,
            ),
          },
        }));
      } catch {
        // Keep the optimistic cleanup if artifact resync fails.
      }
    },

    stopRun: async (sessionId) => {
      await get().client.stopRun(sessionId);
    },

    addAttachment: async (file) => {
      const session = get().sessions.find((item) => item.id === get().currentSessionId);
      if (!session) return;
      const attachment = await get().client.uploadFile(session.workspaceId, file);
      set((state) => ({
        pendingAttachments: [
          ...state.pendingAttachments.filter((current) =>
            current.workspaceId !== attachment.workspaceId ||
            current.relativePath !== attachment.relativePath
          ),
          attachment,
        ],
      }));
    },

    removeAttachment: (workspaceId, relativePath) => {
      set((state) => ({
        pendingAttachments: state.pendingAttachments.filter(
          (attachment) => attachment.workspaceId !== workspaceId || attachment.relativePath !== relativePath,
        ),
      }));
    },

    openArtifact: (id, sessionId) => {
      const artifact = get().artifacts[id];
      const resolvedSessionId = artifact?.sessionId ?? sessionId;
      if (!resolvedSessionId) {
        return;
      }
      withArtifactWorkspace(resolvedSessionId, (workspace) =>
        openArtifactInWorkspace(workspace, id),
      );
      if (!artifact) {
        void get()
          .client.listArtifacts(resolvedSessionId)
          .then((artifacts) => {
            set((state) => ({
              artifacts: {
                ...state.artifacts,
                ...Object.fromEntries(
                  artifacts.map((currentArtifact) => [
                    currentArtifact.id,
                    currentArtifact,
                  ]),
                ),
              },
            }));
          });
      }
    },

    closeArtifact: (id) => {
      const sessionId = get().currentSessionId;
      if (!sessionId) {
        return;
      }
      withArtifactWorkspace(sessionId, (workspace) =>
        closeArtifactInWorkspace(workspace, id),
      );
    },

    setPanelOpen: (open) => {
      const sessionId = get().currentSessionId;
      if (!sessionId) {
        return;
      }
      withArtifactWorkspace(sessionId, (workspace) =>
        setWorkspaceOpen(workspace, open),
      );
    },

    resyncCurrent: async () => {
      const id = get().currentSessionId;
      if (!id) {
        return;
      }
      const messages = await get().client.listMessages(id);
      withBucket(id, (bucket) => ({ ...bucket, messages, loaded: true }));
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
              (message) => {
                const parts = [...message.parts];
                const lastPart = parts[parts.length - 1];
                if (lastPart?.type === "text") {
                  parts[parts.length - 1] = {
                    type: "text",
                    text: lastPart.text + event.delta,
                  };
                } else {
                  parts.push({ type: "text", text: event.delta });
                }
                return { ...message, parts };
              },
            ),
          );
          break;

        case "tool-start":
          withBucket(event.sessionId, (bucket) =>
            updateMessage(
              ensureAssistantMessage(bucket, event.sessionId, event.messageId),
              event.messageId,
              (message) => ({
                ...message,
                parts: [
                  ...message.parts,
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
            updateMessage(bucket, event.messageId, (message) => ({
              ...message,
              parts: message.parts.map((part) =>
                part.type === "tool" && part.toolCall.id === event.toolCallId
                  ? {
                      ...part,
                      toolCall: {
                        ...part.toolCall,
                        status: event.status,
                        result: event.result,
                      } satisfies ToolCall,
                    }
                  : part,
              ),
            })),
          );
          break;

        case "artifact": {
          set((state) => {
            const updates: Pick<ChatState, "artifacts" | "artifactWorkspaces"> = {
              artifacts: {
                ...state.artifacts,
                [event.artifact.id]: event.artifact,
              },
              artifactWorkspaces: state.artifactWorkspaces,
            };

            if (event.sessionId === state.currentSessionId) {
              updates.artifactWorkspaces = {
                ...state.artifactWorkspaces,
                [event.sessionId]: openArtifactInWorkspace(
                  state.artifactWorkspaces[event.sessionId] ??
                    emptyArtifactWorkspace(),
                  event.artifact.id,
                ),
              };
            }

            return updates;
          });

          const messageId = event.messageId;
          if (messageId) {
            withBucket(event.sessionId, (bucket) =>
              updateMessage(bucket, messageId, (message) => ({
                ...message,
                artifactIds: message.artifactIds.includes(event.artifact.id)
                  ? message.artifactIds
                  : [...message.artifactIds, event.artifact.id],
              })),
            );
          }
          break;
        }

        case "done":
          withBucket(event.sessionId, (bucket) => ({
            ...updateMessage(bucket, event.messageId, (message) => ({
              ...message,
              status: "complete",
            })),
            runId: null,
          }));
          touchSession(event.sessionId);
          void get()
            .client.listSessions()
            .then((sessions) => set({ sessions }));
          break;

        case "error":
          withBucket(event.sessionId, (bucket) => ({
            ...updateMessage(bucket, event.messageId, (message) => ({
              ...message,
              status: "error",
            })),
            runId: null,
            error: event.message,
          }));
          break;

        case "ui-command": {
          const command = event.uiCommand;
          if (command.command === "show-artifact") {
            set((state) => {
              const sessionId =
                state.artifacts[command.artifactId]?.sessionId ??
                event.sessionId ??
                state.currentSessionId;
              if (!sessionId) {
                return state;
              }
              return {
                artifactWorkspaces: {
                  ...state.artifactWorkspaces,
                  [sessionId]: openArtifactInWorkspace(
                    state.artifactWorkspaces[sessionId] ??
                      emptyArtifactWorkspace(),
                    command.artifactId,
                  ),
                },
              };
            });
          } else if (command.command === "update-artifact") {
            set((state) => {
              const artifact = state.artifacts[command.artifactId];
              if (!artifact) {
                return state;
              }
              return {
                artifacts: {
                  ...state.artifacts,
                  [command.artifactId]: { ...artifact, payload: command.payload },
                },
              };
            });
          } else if (command.command === "set-panel") {
            set((state) => {
              const sessionId = event.sessionId ?? state.currentSessionId;
              if (!sessionId) {
                return state;
              }
              return {
                artifactWorkspaces: {
                  ...state.artifactWorkspaces,
                  [sessionId]: setWorkspaceOpen(
                    state.artifactWorkspaces[sessionId] ??
                      emptyArtifactWorkspace(),
                    command.open,
                  ),
                },
              };
            });
          }
          break;
        }
      }
    },
  };
});
