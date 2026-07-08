"use client";

import { useChatStore } from "../store";
import { getArtifactRenderer } from "../registry";

export function ArtifactPanel() {
  const panel = useChatStore((s) => s.panel);
  const artifacts = useChatStore((s) => s.artifacts);
  const artifactOrder = useChatStore((s) =>
    s.currentSessionId ? (s.artifactOrder[s.currentSessionId] ?? []) : [],
  );
  const openArtifact = useChatStore((s) => s.openArtifact);
  const setPanelOpen = useChatStore((s) => s.setPanelOpen);

  const active = panel.activeArtifactId ? artifacts[panel.activeArtifactId] : null;
  const Renderer = active ? getArtifactRenderer(active.type) : undefined;

  return (
    <div className="flex h-full flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {active?.title ?? "可视化"}
        </span>
        <button
          title="关闭面板"
          onClick={() => setPanelOpen(false)}
          className="rounded px-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ✕
        </button>
      </div>

      {artifactOrder.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
          {artifactOrder.map((id) => (
            <button
              key={id}
              onClick={() => openArtifact(id)}
              className={`shrink-0 rounded-full px-3 py-0.5 text-xs ${
                id === panel.activeArtifactId
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
              }`}
            >
              {artifacts[id]?.title ?? id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!active ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            暂无内容
          </div>
        ) : Renderer ? (
          <Renderer artifact={active} />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-sm text-neutral-400">
            未注册 “{active.type}” 类型的渲染器
          </div>
        )}
      </div>
    </div>
  );
}
