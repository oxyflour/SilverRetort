import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "silverretort-protocol";
import { useChatStore } from "../store";
import { MessageView } from "./MessageView";

const message: Message = {
  id: "assistant-a",
  sessionId: "session-a",
  role: "assistant",
  parts: [
    { type: "text", text: "## Result\n\n- first\n- second\n\n`code`" },
    {
      type: "tool",
      toolCall: {
        id: "tool-a",
        name: "lookup",
        status: "done",
        detail: "query details",
        result: "tool result",
      },
    },
  ],
  attachments: [],
  artifactIds: [],
  status: "complete",
  createdAt: "2026-07-11T00:00:00Z",
};

const context = {
  artifacts: {},
  running: false,
  sessionMessages: [message],
  sessionArtifactIds: [],
  artifactCreatedAtById: {},
};

beforeEach(() => {
  useChatStore.setState({
    currentSessionId: message.sessionId,
    buckets: {
      [message.sessionId]: {
        messages: [message],
        runId: null,
        loaded: true,
        error: null,
      },
    },
    artifacts: {},
  });
});

describe("MessageView", () => {
  it("renders markdown and completed message state", () => {
    render(
      <MessageView
        message={message}
        context={context}
        hasFollowingMessages={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.queryByText("Streaming")).not.toBeInTheDocument();
  });

  it("keeps tool calls and their details collapsed until requested", async () => {
    const user = userEvent.setup();
    render(
      <MessageView
        message={message}
        context={context}
        hasFollowingMessages={false}
      />,
    );

    expect(screen.getByText("调用了 1 次工具")).toBeInTheDocument();
    expect(screen.queryByText("lookup")).not.toBeInTheDocument();
    expect(screen.queryByText("tool result")).not.toBeInTheDocument();

    const groupToggle = screen.getByRole("button", {
      name: "调用了 1 次工具",
      expanded: false,
    });
    await user.click(groupToggle);

    expect(screen.getByText("lookup")).toBeInTheDocument();
    expect(screen.queryByText("tool result")).not.toBeInTheDocument();

    const detailToggle = screen.getByRole("button", {
      name: "Toggle details for lookup",
      expanded: false,
    });
    await user.click(detailToggle);

    expect(screen.getAllByText("query details")).toHaveLength(2);
    expect(screen.getByText("tool result")).toBeInTheDocument();
    expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    expect(detailToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("loads complete tool details only when a compact card is expanded", async () => {
    const user = userEvent.setup();
    const compactMessage: Message = {
      ...message,
      parts: [
        {
          type: "tool",
          toolCall: {
            id: "tool-a",
            name: "lookup",
            status: "done",
            detail: "summary…",
            detailTruncated: true,
          },
        },
      ],
    };
    const getToolCall = vi
      .spyOn(useChatStore.getState().client, "getToolCall")
      .mockResolvedValue({
        id: "tool-a",
        name: "lookup",
        status: "done",
        detail: "complete details",
        result: "complete result",
      });

    render(
      <MessageView
        message={compactMessage}
        context={{ ...context, sessionMessages: [compactMessage] }}
        hasFollowingMessages={false}
      />,
    );

    expect(getToolCall).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", {
        name: "调用了 1 次工具",
        expanded: false,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Toggle details for lookup",
        expanded: false,
      }),
    );

    expect(await screen.findByText("complete details")).toBeInTheDocument();
    expect(screen.getByText("complete result")).toBeInTheDocument();
    expect(getToolCall).toHaveBeenCalledWith("session-a", "assistant-a", "tool-a");
  });
});
