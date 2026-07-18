import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Artifact } from "silverretort-protocol";
import { ArtifactContent } from "./ArtifactContent";

function markdownArtifact(payload: unknown): Artifact {
  return {
    id: "artifact-a",
    sessionId: "session-a",
    type: "markdown",
    title: "Markdown artifact",
    payload,
    createdAt: "2026-07-18T00:00:00Z",
  };
}

describe("ArtifactContent", () => {
  it("renders a markdown artifact payload into markdown HTML", () => {
    render(
      <ArtifactContent
        artifact={markdownArtifact({
          text: "# Result\n\n- first\n- second\n\n| Name | Value |\n| --- | --- |\n| A | 1 |",
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Result" }),
    ).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("does not fall back to an unregistered state for markdown artifacts", () => {
    render(<ArtifactContent artifact={markdownArtifact({ text: "plain text" })} />);

    expect(
      screen.queryByText('No renderer registered for "markdown"'),
    ).not.toBeInTheDocument();
    expect(screen.getByText("plain text")).toBeInTheDocument();
  });
});
