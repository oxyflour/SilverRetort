"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { openArtifactInNewWindow } from "../openArtifactInNewWindow";
import { useChatStore } from "../store";
import { ArtifactContent } from "./ArtifactContent";
import { AppIcon } from "./icons";

const EMPTY_TAB_IDS: string[] = [];

export function ArtifactPanel() {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const workspace = useChatStore((state) =>
    currentSessionId ? state.artifactWorkspaces[currentSessionId] : undefined,
  );
  const artifacts = useChatStore((state) => state.artifacts);
  const openArtifact = useChatStore((state) => state.openArtifact);
  const closeArtifact = useChatStore((state) => state.closeArtifact);
  const setPanelOpen = useChatStore((state) => state.setPanelOpen);

  const tabIds = workspace?.tabIds ?? EMPTY_TAB_IDS;
  const activeArtifactId = workspace?.activeArtifactId ?? null;
  const activeArtifact = activeArtifactId ? artifacts[activeArtifactId] : null;

  const popOutArtifact = (artifactId: string) => {
    if (openArtifactInNewWindow(artifactId)) {
      closeArtifact(artifactId);
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabIds.map((id) => {
            const artifact = artifacts[id];
            const active = id === activeArtifactId;
            return (
              <div
                key={id}
                className={`flex shrink-0 items-center rounded-full border px-1 ${
                  active
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                    : "border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-900"
                }`}
              >
                <button
                  type="button"
                  onClick={() => openArtifact(id)}
                  className="min-w-0 max-w-44 truncate px-2 py-1 text-left text-xs"
                >
                  {artifact?.title ?? id.slice(0, 8)}
                </button>
                <button
                  type="button"
                  title="Close tab"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeArtifact(id);
                  }}
                  className={`rounded-full p-1.5 ${
                    active
                      ? "text-white/80 hover:text-white dark:text-neutral-700 dark:hover:text-neutral-900"
                      : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  }`}
                >
                  <AppIcon icon={X} className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        {activeArtifactId && (
          <button
            type="button"
            title="Refresh artifact"
            onClick={() => setRefreshVersion((version) => version + 1)}
            className="shrink-0 rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <AppIcon icon={RefreshCw} className="h-4 w-4" />
          </button>
        )}
        {activeArtifactId && (
          <button
            type="button"
            title="Open in new window"
            onClick={() => popOutArtifact(activeArtifactId)}
            className="shrink-0 rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <AppIcon icon={ExternalLink} className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          title="Close panel"
          onClick={() => setPanelOpen(false)}
          className="shrink-0 rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <AppIcon icon={X} className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <ArtifactContent
          key={`${activeArtifactId ?? "empty"}:${refreshVersion}`}
          artifact={activeArtifact}
          loading={Boolean(activeArtifactId && !activeArtifact)}
        />
      </div>
    </div>
  );
}
