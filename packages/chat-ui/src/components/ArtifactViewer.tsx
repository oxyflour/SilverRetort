"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiClient, Artifact, subscribeEvents } from "silverretort-protocol";
import { ArtifactContent } from "./ArtifactContent";

interface ArtifactViewerProps {
  artifactId: string;
}

type ViewerStatus = "loading" | "ready" | "not-found" | "error";

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("HTTP 404");
}

export function ArtifactViewer({ artifactId }: ArtifactViewerProps) {
  const client = useMemo(() => new ApiClient(), []);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    setArtifact(null);
    setStatus("loading");

    void client
      .getArtifact(artifactId)
      .then((nextArtifact) => {
        if (cancelled) {
          return;
        }
        setArtifact(nextArtifact);
        setStatus("ready");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setStatus(isNotFoundError(error) ? "not-found" : "error");
      });

    const stop = subscribeEvents(client.eventsUrl(), {
      onEvent: (event) => {
        if (event.type === "artifact" && event.artifact.id === artifactId) {
          setArtifact(event.artifact);
          setStatus("ready");
          return;
        }

        if (
          event.type === "ui-command" &&
          event.uiCommand.command === "update-artifact" &&
          event.uiCommand.artifactId === artifactId
        ) {
          const { payload } = event.uiCommand;
          setArtifact((currentArtifact) =>
            currentArtifact
              ? { ...currentArtifact, payload }
              : currentArtifact,
          );
        }
      },
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [artifactId, client]);

  useEffect(() => {
    document.title = artifact
      ? `${artifact.title} | SilverRetort`
      : "Artifact | SilverRetort";
  }, [artifact]);

  const emptyMessage =
    status === "not-found"
      ? "Artifact not found or no longer available."
      : status === "error"
        ? "Failed to load artifact."
        : "No artifact selected";

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="min-h-0 flex-1">
        <ArtifactContent
          artifact={artifact}
          loading={status === "loading"}
          emptyMessage={emptyMessage}
        />
      </div>
    </div>
  );
}
