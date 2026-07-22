import { z } from "zod";
import {
  Artifact,
  ArtifactContext,
  ArtifactContextSchema,
  ArtifactContextUpdateRequest,
  ArtifactSchema,
  Attachment,
  AttachmentSchema,
  Message,
  MessageSearchResponse,
  MessageSearchResponseSchema,
  MessageSchema,
  RestartMessageRequest,
  SendChatRequest,
  SendChatResponse,
  SendChatResponseSchema,
  Session,
  SessionSchema,
  ToolCall,
  ToolCallSchema,
  Workspace,
  WorkspaceSchema,
  WorkspaceTemplate,
  WorkspaceTemplateSchema,
  HermesModelsResponse,
  HermesModelsResponseSchema,
  HermesRuntimeResponse,
  HermesRuntimeResponseSchema,
  HermesUsageResponse,
  HermesUsageResponseSchema,
  SessionModel,
  SessionModelSchema,
  SetModelRequest,
  SwitchProfile,
  SwitchProfileSchema,
  SlashCommand,
  SlashCommandSchema,
} from "./types";

/** 类型化 REST 客户端；baseUrl 一般为空串（同源经 next 代理到 uvicorn） */
export class ApiClient {
  constructor(private baseUrl = "") {}

  private async request<T>(
    schema: { parse: (data: unknown) => T },
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers:
        init?.body instanceof FormData
          ? undefined
          : { "content-type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        detail = typeof payload?.detail === "string" ? payload.detail : "";
      } catch {
        // Keep the generic HTTP error when the server did not return JSON.
      }
      throw new Error(detail || `${init?.method ?? "GET"} ${path} failed: HTTP ${res.status}`);
    }
    return schema.parse(await res.json());
  }

  listSessions(): Promise<Session[]> {
    return this.request(z.array(SessionSchema), "/api/sessions");
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.request(z.array(WorkspaceSchema), "/api/workspaces");
  }

  listWorkspaceTemplates(): Promise<WorkspaceTemplate[]> {
    return this.request(
      z.array(WorkspaceTemplateSchema),
      "/api/workspace-templates",
    );
  }

  listSwitchProfiles(): Promise<SwitchProfile[]> {
    return this.request(z.array(SwitchProfileSchema), "/api/switch-profiles");
  }

  createSwitchProfile(body: {
    name: string;
    switchUrl: string;
    hermesApiKey: string;
  }): Promise<SwitchProfile> {
    return this.request(SwitchProfileSchema, "/api/switch-profiles", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateSwitchProfile(
    id: string,
    body: { name: string; switchUrl: string; hermesApiKey?: string | null },
  ): Promise<SwitchProfile> {
    return this.request(SwitchProfileSchema, `/api/switch-profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async deleteSwitchProfile(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/switch-profiles/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`DELETE switch profile failed: HTTP ${res.status}`);
  }

  listSlashCommands(sessionId?: string | null, workspaceId?: string | null): Promise<SlashCommand[]> {
    return this.request(z.array(SlashCommandSchema), `/api/hermes/slash-commands${contextQuery(sessionId, workspaceId)}`);
  }

  listHermesModels(sessionId?: string | null, workspaceId?: string | null): Promise<HermesModelsResponse> {
    return this.request(HermesModelsResponseSchema, `/api/hermes/models${contextQuery(sessionId, workspaceId)}`);
  }

  getHermesUsage(sessionId?: string | null): Promise<HermesUsageResponse> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.request(HermesUsageResponseSchema, `/api/hermes/usage${query}`);
  }

  getHermesRuntime(sessionId?: string | null): Promise<HermesRuntimeResponse> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.request(HermesRuntimeResponseSchema, `/api/hermes/runtime${query}`);
  }

  async stopHermesProcess(sessionId: string, processId: string): Promise<void> {
    await this.request(
      z.object({ ok: z.boolean() }),
      `/api/hermes/processes/${encodeURIComponent(processId)}?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  }

  getDefaultModel(): Promise<SessionModel> {
    return this.request(SessionModelSchema, "/api/hermes/default-model");
  }

  setDefaultModel(body: SetModelRequest): Promise<SessionModel> {
    return this.request(SessionModelSchema, "/api/hermes/default-model", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  createWorkspace(
    name: string,
    connectionId?: string,
    templateId?: string | null,
  ): Promise<Workspace> {
    return this.request(WorkspaceSchema, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(connectionId ? { connectionId } : {}),
        ...(templateId ? { templateId } : {}),
      }),
    });
  }

  renameWorkspace(id: string, name: string): Promise<Workspace> {
    return this.request(WorkspaceSchema, `/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async deleteWorkspace(id: string, force = false): Promise<void> {
    const query = force ? "?force=true" : "";
    const res = await fetch(`${this.baseUrl}/api/workspaces/${id}${query}`, { method: "DELETE" });
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        detail = typeof payload?.detail === "string" ? payload.detail : "";
      } catch {
        // Keep the generic HTTP error when the server did not return JSON.
      }
      throw new Error(detail || `DELETE workspace failed: HTTP ${res.status}`);
    }
  }

  createSession(workspaceId: string, title?: string): Promise<Session> {
    return this.request(SessionSchema, `/api/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  renameSession(id: string, title: string): Promise<Session> {
    return this.request(SessionSchema, `/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }

  getSessionModel(sessionId: string): Promise<SessionModel> {
    return this.request(SessionModelSchema, `/api/sessions/${sessionId}/model`);
  }

  setSessionModel(sessionId: string, body: SetModelRequest): Promise<SessionModel> {
    return this.request(SessionModelSchema, `/api/sessions/${sessionId}/model`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteSession(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`DELETE session failed: HTTP ${res.status}`);
  }

  listMessages(sessionId: string): Promise<Message[]> {
    return this.request(
      z.array(MessageSchema),
      `/api/sessions/${sessionId}/messages?compact=true`,
    );
  }

  searchMessages(query: string): Promise<MessageSearchResponse> {
    return this.request(
      MessageSearchResponseSchema,
      `/api/messages/search?q=${encodeURIComponent(query)}`,
    );
  }

  getToolCall(
    sessionId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<ToolCall> {
    return this.request(
      ToolCallSchema,
      `/api/sessions/${sessionId}/messages/${messageId}/tools/${toolCallId}`,
    );
  }

  listArtifacts(sessionId: string): Promise<Artifact[]> {
    return this.request(z.array(ArtifactSchema), `/api/sessions/${sessionId}/artifacts`);
  }

  getArtifact(artifactId: string): Promise<Artifact> {
    return this.request(
      ArtifactSchema,
      `/api/artifacts/${encodeURIComponent(artifactId)}`,
    );
  }

  setArtifactContext(
    artifactId: string,
    body: ArtifactContextUpdateRequest,
  ): Promise<ArtifactContext> {
    return this.request(
      ArtifactContextSchema,
      `/api/artifacts/${encodeURIComponent(artifactId)}/context`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-silverretort-artifact-bridge": "1",
        },
        body: JSON.stringify(body),
      },
    );
  }

  listArtifactContexts(sessionId: string): Promise<ArtifactContext[]> {
    return this.request(
      z.array(ArtifactContextSchema),
      `/api/sessions/${encodeURIComponent(sessionId)}/artifact-contexts`,
    );
  }

  async clearArtifactContext(artifactId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/artifacts/${encodeURIComponent(artifactId)}/context`,
      {
        method: "DELETE",
        headers: { "x-silverretort-artifact-bridge": "1" },
      },
    );
    if (!res.ok) {
      throw new Error(`DELETE artifact context failed: HTTP ${res.status}`);
    }
  }

  artifactContentUrl(artifactId: string, assetPath?: string): string {
    const base = `${this.baseUrl}/api/artifacts/${encodeURIComponent(artifactId)}/content/`;
    return assetPath ? `${base}${encodePath(assetPath)}` : base;
  }

  sendChat(sessionId: string, body: SendChatRequest): Promise<SendChatResponse> {
    return this.request(SendChatResponseSchema, `/api/sessions/${sessionId}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  restartFromMessage(
    sessionId: string,
    messageId: string,
    body: RestartMessageRequest,
  ): Promise<SendChatResponse> {
    return this.request(
      SendChatResponseSchema,
      `/api/sessions/${sessionId}/messages/${messageId}/restart`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async stopRun(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/stop`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`stop run failed: HTTP ${res.status}`);
  }

  uploadFile(workspaceId: string, file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file);
    return this.request(AttachmentSchema, `/api/workspaces/${workspaceId}/files`, {
      method: "POST",
      body: form,
    });
  }

  listWorkspaceFiles(workspaceId: string): Promise<Attachment[]> {
    return this.request(z.array(AttachmentSchema), `/api/workspaces/${workspaceId}/files`);
  }

  fileUrl(workspaceId: string, relativePath: string): string {
    return `${this.baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/files/content/${encodePath(relativePath)}`;
  }

  eventsUrl(): string {
    return `${this.baseUrl}/api/events`;
  }
}

function encodePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function contextQuery(sessionId?: string | null, workspaceId?: string | null): string {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  if (workspaceId) params.set("workspaceId", workspaceId);
  const query = params.toString();
  return query ? `?${query}` : "";
}
