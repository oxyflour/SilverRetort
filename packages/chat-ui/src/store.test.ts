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
    goalStates: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("chat event routing", () => {
  it("stores goal state events by session", () => {
    useChatStore.getState().applyEvent({
      type: "goal-state",
      sessionId,
      goal: {
        objective: "Finish the feature",
        status: "active",
        turnsUsed: 1,
        maxTurns: 20,
        lastVerdict: "continue",
        lastReason: "More work remains",
        pausedReason: null,
      },
    });

    expect(useChatStore.getState().goalStates[sessionId]).toMatchObject({
      objective: "Finish the feature",
      status: "active",
      turnsUsed: 1,
    });
  });

  it("applies goal action state returned by the API", async () => {
    vi.spyOn(useChatStore.getState().client, "goalAction").mockResolvedValue({
      goal: {
        objective: "Finish the feature",
        status: "paused",
        turnsUsed: 1,
        maxTurns: 20,
        lastVerdict: "continue",
        lastReason: "More work remains",
        pausedReason: "user-paused",
      },
      message: "paused",
      runId: null,
      assistantMessageId: null,
    });

    await useChatStore.getState().goalAction("pause");

    expect(useChatStore.getState().goalStates[sessionId]?.status).toBe("paused");
  });

  it("opens the current session artifact panel when a markdown artifact arrives", () => {
    useChatStore.getState().applyEvent({
      type: "artifact",
      sessionId,
      runId: "run-a",
      messageId,
      artifact: {
        id: "artifact-a",
        sessionId,
        type: "markdown",
        title: "Markdown artifact",
        payload: { text: "# Render me" },
        createdAt: "2026-07-18T00:00:00Z",
      },
    });

    expect(useChatStore.getState().artifacts["artifact-a"]).toMatchObject({
      type: "markdown",
      payload: { text: "# Render me" },
    });
    expect(useChatStore.getState().artifactWorkspaces[sessionId]).toEqual({
      open: true,
      activeArtifactId: "artifact-a",
      tabIds: ["artifact-a"],
    });
    expect(
      useChatStore.getState().buckets[sessionId]?.messages[0]?.artifactIds,
    ).toEqual(["artifact-a"]);
  });

  it("opens markdown artifacts created by MCP UI tools without a message id", () => {
    useChatStore.getState().applyEvent({
      type: "artifact",
      sessionId,
      artifact: {
        id: "artifact-b",
        sessionId,
        type: "markdown",
        title: "Tool markdown artifact",
        payload: { text: "tool-created markdown" },
        createdAt: "2026-07-18T00:00:00Z",
      },
    });

    expect(useChatStore.getState().artifacts["artifact-b"]).toMatchObject({
      type: "markdown",
      payload: { text: "tool-created markdown" },
    });
    expect(useChatStore.getState().artifactWorkspaces[sessionId]).toEqual({
      open: true,
      activeArtifactId: "artifact-b",
      tabIds: ["artifact-b"],
    });
    expect(
      useChatStore.getState().buckets[sessionId]?.messages[0]?.artifactIds,
    ).toEqual([]);
  });

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
      baseUrl: "",
      hasApiKey: false,
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

describe("workspace templates", () => {
  it("passes the selected template to the API and creates the first session", async () => {
    const workspace = {
      id: "workspace-domain",
      name: "Domain workspace",
      templateId: "structural-design",
      status: "active" as const,
      connectionId: "local",
      switchMode: "local" as const,
      switchUrl: "",
      hasHermesApiKey: false,
      createdAt: "2026-07-20T00:00:00Z",
      updatedAt: "2026-07-20T00:00:00Z",
    };
    const createWorkspace = vi
      .spyOn(useChatStore.getState().client, "createWorkspace")
      .mockResolvedValue(workspace);
    const createSession = vi
      .spyOn(useChatStore.getState().client, "createSession")
      .mockResolvedValue({
        id: "session-domain",
        workspaceId: workspace.id,
        title: "New chat",
        createdAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-20T00:00:00Z",
      });
    vi.spyOn(useChatStore.getState().client, "listMessages").mockResolvedValue([]);
    vi.spyOn(useChatStore.getState().client, "listArtifacts").mockResolvedValue([]);
    vi.spyOn(useChatStore.getState().client, "listArtifactContexts").mockResolvedValue([]);

    await useChatStore.getState().createWorkspace(
      workspace.name,
      "local",
      workspace.templateId,
    );

    expect(createWorkspace).toHaveBeenCalledWith(
      workspace.name,
      "local",
      workspace.templateId,
    );
    expect(createSession).toHaveBeenCalledWith(workspace.id);
    expect(useChatStore.getState().currentWorkspaceId).toBe(workspace.id);
    expect(useChatStore.getState().currentSessionId).toBe("session-domain");
  });
});
