"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Search, X } from "lucide-react";
import type { MessageSearchResponse } from "silverretort-protocol";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";
import { Modal } from "./SidebarDialog";

export function SearchSessionsModal({
  searchQuery,
  setSearchQuery,
  onClose,
}: {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onClose: () => void;
}) {
  const client = useChatStore((state) => state.client);
  const workspaces = useChatStore((state) => state.workspaces);
  const sessions = useChatStore((state) => state.sessions);
  const buckets = useChatStore((state) => state.buckets);
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const selectSession = useChatStore((state) => state.selectSession);
  const normalizedQuery = searchQuery.trim();
  const searching = normalizedQuery.length > 0;
  const [messageResponse, setMessageResponse] =
    useState<MessageSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const query = normalizedQuery;
    const id = requestId.current + 1;
    requestId.current = id;
    if (!query) {
      setMessageResponse(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      client
        .searchMessages(query)
        .then((response) => {
          if (requestId.current === id) setMessageResponse(response);
        })
        .catch(() => {
          if (requestId.current === id) {
            setMessageResponse(null);
            setError("Message search unavailable.");
          }
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [client, normalizedQuery]);

  const resultViews = useMemo(() => {
    if (!searching) return [];
    const query = normalizedQuery.toLowerCase();
    const messageResults = new Map(
      (messageResponse?.results ?? []).map((result) => [result.sessionId, result]),
    );
    return workspaces
      .map((workspace) => {
        const workspaceSessions = sessions.filter(
          (session) => session.workspaceId === workspace.id,
        );
        const workspaceMatches = workspace.name.toLowerCase().includes(query);
        const items = workspaceSessions
          .map((session) => ({
            session,
            localMatch:
              workspaceMatches || session.title.toLowerCase().includes(query),
            messageResult: messageResults.get(session.id),
          }))
          .filter((item) => item.localMatch || item.messageResult);
        return { workspace, items };
      })
      .filter((view) => view.items.length > 0);
  }, [messageResponse, normalizedQuery, searching, sessions, workspaces]);

  return (
    <Modal title="Search sessions" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="relative">
          <AppIcon
            icon={Search}
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
          />
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
            placeholder="Search sessions"
            className="h-10 w-full rounded-md border border-neutral-300 bg-white px-8 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-500"
          />
          {searchQuery && (
            <button
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <AppIcon icon={X} className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="max-h-96 min-h-20 overflow-y-auto rounded-md border border-neutral-200 p-2 dark:border-neutral-700">
          {loading && (
            <div className="px-2 py-2 text-sm text-neutral-500 dark:text-neutral-400">
              Searching messages...
            </div>
          )}
          {error && (
            <div className="px-2 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          {searching && !loading && !error && resultViews.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
              No sessions found
            </div>
          )}
          {resultViews.map(({ workspace, items }) => (
            <section key={workspace.id} className="mb-2 last:mb-0">
              <div className="flex items-center gap-2 px-2 py-1 text-sm font-medium">
                {workspace.switchMode === "remote" && (
                  <span title={workspace.switchUrl}>
                    <AppIcon
                      icon={Cloud}
                      className="h-3.5 w-3.5 shrink-0 text-neutral-500"
                    />
                  </span>
                )}
                <span className="min-w-0 truncate" title={workspace.name}>
                  {workspace.name}
                </span>
              </div>
              {items.map(({ session, messageResult }) => (
                <button
                  key={session.id}
                  onClick={() => {
                    void selectSession(session.id);
                    onClose();
                  }}
                  className={`mt-1 w-full rounded-md px-3 py-2 text-left text-sm ${
                    session.id === currentSessionId
                      ? "bg-neutral-200 dark:bg-neutral-700"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {buckets[session.id]?.runId != null && (
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={session.title}>
                      {session.title}
                    </span>
                  </div>
                  {messageResult?.hits.map((hit) => (
                    <div
                      key={hit.messageId}
                      className="mt-1 line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400"
                    >
                      <span className="font-medium">{hit.role}</span>: {hit.snippet}
                    </div>
                  ))}
                  {messageResult && messageResult.totalHits > messageResult.hits.length && (
                    <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      +{messageResult.totalHits - messageResult.hits.length} more matches
                    </div>
                  )}
                </button>
              ))}
            </section>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
