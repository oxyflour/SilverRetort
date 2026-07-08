"use client";

import { useState } from "react";
import { useChatStore } from "../store";

export function SessionSidebar() {
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const buckets = useChatStore((s) => s.buckets);
  const createSession = useChatStore((s) => s.createSession);
  const selectSession = useChatStore((s) => s.selectSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div className="flex h-full flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="p-2">
        <button
          onClick={() => void createSession()}
          className="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          + 新会话
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((session) => {
          const running = buckets[session.id]?.runId != null;
          const active = session.id === currentSessionId;
          return (
            <div
              key={session.id}
              onClick={() => void selectSession(session.id)}
              className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                active
                  ? "bg-neutral-200 dark:bg-neutral-700"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {running && (
                <span
                  className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
                  title="正在生成"
                />
              )}
              {editingId === session.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void renameSession(session.id, draft.trim() || session.title);
                      setEditingId(null);
                    }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => setEditingId(null)}
                  className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1 dark:border-neutral-600 dark:bg-neutral-800"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate" title={session.title}>
                  {session.title}
                </span>
              )}
              <span className="hidden shrink-0 gap-1 group-hover:flex">
                <button
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(session.id);
                    setDraft(session.title);
                  }}
                  className="rounded px-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  ✎
                </button>
                <button
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteSession(session.id);
                  }}
                  className="rounded px-1 text-neutral-500 hover:text-red-600"
                >
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
