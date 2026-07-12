import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "silverretort-protocol";
import { useChatStore } from "./store";

const sessionId = "session-a";
const messageId = "assistant-a";

function assistant(parts: Message["parts"] = []): Message {
  return {
    id: messageId,
    sessionId,
    role: "assistant",
    parts,
    attachments: [],
    artifactIds: [],
    status: "streaming",
    createdAt: "2026-07-11T00:00:00Z",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useChatStore.setState({
    currentSessionId: sessionId,
    buckets: {
      [sessionId]: {
        messages: [assistant()],
        runId: "run-a",
        loaded: true,
        error: null,
      },
    },
    artifacts: {},
    artifactWorkspaces: {},
    pendingAttachments: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("chat event routing", () => {
  it("coalesces a burst of text deltas into one store notification", () => {
    let notifications = 0;
    const unsubscribe = useChatStore.subscribe(() => {
      notifications += 1;
    });

    for (let index = 0; index < 100; index += 1) {
      useChatStore.getState().applyEvent({
        type: "text-delta",
        sessionId,
        runId: "run-a",
        messageId,
        delta: "x",
      });
    }

    expect(notifications).toBe(0);
    vi.runAllTimers();
    unsubscribe();

    expect(notifications).toBe(1);
    expect(
      useChatStore.getState().buckets[sessionId]?.messages[0]?.parts,
    ).toEqual([{ type: "text", text: "x".repeat(100) }]);
  });

  it("appends consecutive text deltas to the last text part", () => {
    const applyEvent = useChatStore.getState().applyEvent;
    applyEvent({
      type: "text-delta",
      sessionId,
      runId: "run-a",
      messageId,
      delta: "hello ",
    });
    applyEvent({
      type: "text-delta",
      sessionId,
      runId: "run-a",
      messageId,
      delta: "world",
    });
    vi.runAllTimers();

    expect(useChatStore.getState().buckets[sessionId]?.messages[0]?.parts).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("keeps text and tool parts in event order", () => {
    const applyEvent = useChatStore.getState().applyEvent;
    applyEvent({
      type: "text-delta",
      sessionId,
      runId: "run-a",
      messageId,
      delta: "before",
    });
    applyEvent({
      type: "tool-start",
      sessionId,
      runId: "run-a",
      messageId,
      toolCallId: "tool-a",
      name: "lookup",
      detail: "query",
    });
    applyEvent({
      type: "text-delta",
      sessionId,
      runId: "run-a",
      messageId,
      delta: "after",
    });
    vi.runAllTimers();

    expect(useChatStore.getState().buckets[sessionId]?.messages[0]?.parts).toEqual([
      { type: "text", text: "before" },
      {
        type: "tool",
        toolCall: {
          id: "tool-a",
          name: "lookup",
          status: "running",
          detail: "query",
        },
      },
      { type: "text", text: "after" },
    ]);
  });

  it("completes the matching tool without changing other parts", () => {
    useChatStore.setState((state) => ({
      buckets: {
        ...state.buckets,
        [sessionId]: {
          ...state.buckets[sessionId]!,
          messages: [
            assistant([
              { type: "text", text: "before" },
              {
                type: "tool",
                toolCall: { id: "tool-a", name: "lookup", status: "running" },
              },
            ]),
          ],
        },
      },
    }));

    useChatStore.getState().applyEvent({
      type: "tool-end",
      sessionId,
      runId: "run-a",
      messageId,
      toolCallId: "tool-a",
      status: "done",
      result: "large result",
    });

    expect(useChatStore.getState().buckets[sessionId]?.messages[0]?.parts).toEqual([
      { type: "text", text: "before" },
      {
        type: "tool",
        toolCall: {
          id: "tool-a",
          name: "lookup",
          status: "done",
          result: "large result",
        },
      },
    ]);
  });

  it("routes background-session events without changing the current session", () => {
    useChatStore.getState().applyEvent({
      type: "text-delta",
      sessionId: "session-b",
      runId: "run-b",
      messageId: "assistant-b",
      delta: "background",
    });
    vi.runAllTimers();

    expect(useChatStore.getState().currentSessionId).toBe(sessionId);
    expect(useChatStore.getState().buckets[sessionId]?.messages[0]?.parts).toEqual([]);
    expect(useChatStore.getState().buckets["session-b"]?.messages[0]?.parts).toEqual([
      { type: "text", text: "background" },
    ]);
  });
});

describe("session model state", () => {
  it("stores the selected session model returned by the API", async () => {
    const model = {
      id: "openrouter:anthropic/claude-sonnet-4",
      provider: "openrouter",
      providerLabel: "OpenRouter",
      model: "anthropic/claude-sonnet-4",
      label: "claude-sonnet-4",
      available: true,
      current: false,
    };
    const sessionModel = {
      sessionKey: "silverretort:session-a",
      source: "session" as const,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      modelId: model.id,
      defaultProvider: "custom",
      defaultModel: "default-model",
    };
    const spy = vi
      .spyOn(useChatStore.getState().client, "setSessionModel")
      .mockResolvedValue(sessionModel);

    await useChatStore.getState().setSessionModel(sessionId, model);

    expect(spy).toHaveBeenCalledWith(sessionId, {
      modelId: model.id,
      provider: model.provider,
      model: model.model,
    });
    expect(useChatStore.getState().sessionModels[sessionId]).toEqual(sessionModel);
  });
});
