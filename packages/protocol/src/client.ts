import { z } from "zod";
import {
  Artifact,
  ArtifactSchema,
  Attachment,
  AttachmentSchema,
  Message,
  MessageSchema,
  RestartMessageRequest,
  SendChatRequest,
  SendChatResponse,
  SendChatResponseSchema,
  Session,
  SessionSchema,
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
      throw new Error(`${init?.method ?? "GET"} ${path} failed: HTTP ${res.status}`);
    }
    return schema.parse(await res.json());
  }

  listSessions(): Promise<Session[]> {
    return this.request(z.array(SessionSchema), "/api/sessions");
  }

  createSession(title?: string): Promise<Session> {
    return this.request(SessionSchema, "/api/sessions", {
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

  async deleteSession(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`DELETE session failed: HTTP ${res.status}`);
  }

  listMessages(sessionId: string): Promise<Message[]> {
    return this.request(z.array(MessageSchema), `/api/sessions/${sessionId}/messages`);
  }

  listArtifacts(sessionId: string): Promise<Artifact[]> {
    return this.request(z.array(ArtifactSchema), `/api/sessions/${sessionId}/artifacts`);
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

  uploadFile(file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file);
    return this.request(AttachmentSchema, "/api/files", {
      method: "POST",
      body: form,
    });
  }

  fileUrl(id: string): string {
    return `${this.baseUrl}/api/files/${id}`;
  }

  eventsUrl(): string {
    return `${this.baseUrl}/api/events`;
  }
}
