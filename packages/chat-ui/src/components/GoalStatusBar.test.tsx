import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store";
import { GoalStatusBar } from "./GoalStatusBar";

const sessionId = "session-goal";

beforeEach(() => {
  useChatStore.setState({
    currentSessionId: sessionId,
    goalStates: {
      [sessionId]: {
        objective: "Finish the feature",
        status: "active",
        turnsUsed: 3,
        maxTurns: 20,
        lastVerdict: "continue",
        lastReason: "One check remains",
        pausedReason: null,
      },
    },
    buckets: {
      [sessionId]: {
        messages: [],
        runId: "run-goal",
        loaded: true,
        error: null,
      },
    },
  });
});

describe("GoalStatusBar", () => {
  it("shows goal progress and pauses after the current turn", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ goalAction: action });

    render(<GoalStatusBar />);

    expect(screen.getByText("Finish the feature")).toBeInTheDocument();
    expect(screen.getByText("3/20")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Pause goal after the current turn"));

    await waitFor(() => expect(action).toHaveBeenCalledWith("pause"));
  });

  it("does not render when the session has no goal", () => {
    useChatStore.setState({ goalStates: { [sessionId]: null } });

    const { container } = render(<GoalStatusBar />);

    expect(container).toBeEmptyDOMElement();
  });
});
