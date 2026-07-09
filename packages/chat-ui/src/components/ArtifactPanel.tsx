"use client";

import { getArtifactRenderer } from "../registry";
import { useChatStore } from "../store";

const EMPTY_TAB_IDS: string[] = [];

export function ArtifactPanel() {
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
  const Renderer = activeArtifact
    ? getArtifactRenderer(activeArtifact.type)
    : undefined;

  return (
    <div className="flex h-full flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {activeArtifact?.title ?? "Artifacts"}
        </span>
        <button
          type="button"
          title="Close panel"
          onClick={() => setPanelOpen(false)}
          className="rounded px-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          x
        </button>
      </div>

      {tabIds.length > 0 && (
        <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
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
                  className={`rounded-full px-2 py-1 text-xs ${
                    active
                      ? "text-white/80 hover:text-white dark:text-neutral-700 dark:hover:text-neutral-900"
                      : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  }`}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!activeArtifact && activeArtifactId ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            Loading artifact...
          </div>
        ) : !activeArtifact ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            No artifact selected
          </div>
        ) : Renderer ? (
          <Renderer artifact={activeArtifact} />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-sm text-neutral-400">
            No renderer registered for "{activeArtifact.type}"
          </div>
        )}
      </div>
    </div>
  );
}
