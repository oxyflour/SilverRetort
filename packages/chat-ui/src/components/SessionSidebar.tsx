"use client";

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderPlus,
  MessageSquarePlus,
  PencilLine,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { UserSettingsPanel } from "silverretort-setting-ui";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";

export function SessionSidebar() {
  const store = useChatStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("New workspace");
  const [createConnectionId, setCreateConnectionId] = useState<string | undefined>(undefined);
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedSessionCounts, setExpandedSessionCounts] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const available = Boolean(
    store.workspaceCapability?.supported && store.workspaceCapability.writable,
  );
  const currentWorkspace = store.workspaces.find(
    (workspace) => workspace.id === store.currentWorkspaceId,
  );
  const defaultConnectionId = currentWorkspace?.connectionId;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const searching = normalizedSearchQuery.length > 0;
  const workspaceViews = store.workspaces
    .map((workspace) => {
      const sessions = store.sessions.filter(
        (session) => session.workspaceId === workspace.id,
      );
      const workspaceMatches = workspace.name
        .toLowerCase()
        .includes(normalizedSearchQuery);
      const matchingSessions = searching
        ? sessions.filter((session) =>
            session.title.toLowerCase().includes(normalizedSearchQuery),
          )
        : sessions;
      const visibleSessionCount = expandedSessionCounts[workspace.id] ?? 5;
      const visibleSessions = searching
        ? workspaceMatches
          ? sessions
          : matchingSessions
        : sessions.slice(0, visibleSessionCount);
      const hiddenSessionCount = searching
        ? 0
        : sessions.length - visibleSessions.length;

      return {
        workspace,
        sessions,
        collapsed: store.collapsedWorkspaceIds.includes(workspace.id),
        visibleSessionCount,
        visibleSessions,
        hiddenSessionCount,
        running: sessions.some((session) => store.buckets[session.id]?.runId != null),
        matched: !searching || workspaceMatches || visibleSessions.length > 0,
      };
    })
    .filter((view) => view.matched);

  return (
    <div className="flex h-full flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="space-y-2 p-2">
        <div className="relative ml-10">
          <AppIcon
            icon={Search}
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
          />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search sessions"
            className="h-9 w-full rounded-md border border-neutral-300 bg-white px-8 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-500"
          />
          {searchQuery && (
            <button
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <AppIcon icon={X} className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="relative flex">
          <button
            disabled={!available}
            onClick={() => {
              setCreateName("New workspace");
              setCreateConnectionId(defaultConnectionId);
              setCreating(true);
            }}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-l-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            <AppIcon icon={FolderPlus} className="h-4 w-4" />
            New workspace
          </button>
          <button
            disabled={!available}
            title="Choose connection"
            onClick={() => setConnectionMenuOpen((open) => !open)}
            className="grid w-9 place-items-center rounded-r-md border border-l-0 border-neutral-300 text-neutral-500 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            <AppIcon icon={ChevronDown} className="h-4 w-4" />
          </button>
          {connectionMenuOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {store.switchProfiles.map((profile) => (
                <button
                  key={profile.id}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  title={profile.switchUrl || profile.name}
                  onClick={() => {
                    setConnectionMenuOpen(false);
                    setCreateName("New workspace");
                    setCreateConnectionId(profile.id);
                    setCreating(true);
                  }}
                >
                  {profile.mode === "remote" && <AppIcon icon={Cloud} className="h-4 w-4 text-neutral-500" />}
                  <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {!available && store.workspaceCapability && (
          <p className="px-1 text-xs text-amber-600">
            Workspace support is unavailable in the current Hermes build.
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {searching && workspaceViews.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
            No sessions found
          </div>
        )}
        {workspaceViews.map((view) => {
          const {
            workspace,
            collapsed,
            visibleSessionCount,
            visibleSessions,
            hiddenSessionCount,
            running,
          } = view;
          const displayCollapsed = searching ? false : collapsed;
          return (
            <section key={workspace.id} className="mb-2">
              <div
                className={`group flex items-center gap-1 rounded-md px-1 py-1 text-sm ${
                  store.currentWorkspaceId === workspace.id
                    ? "bg-neutral-200/70 dark:bg-neutral-800"
                    : ""
                }`}
              >
                <button
                  className="rounded p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                  onClick={() => {
                    if (!searching) store.toggleWorkspace(workspace.id);
                  }}
                  title={
                    searching
                      ? "Workspace expanded in search"
                      : displayCollapsed
                        ? "Expand workspace"
                        : "Collapse workspace"
                  }
                >
                  <AppIcon
                    icon={displayCollapsed ? ChevronRight : ChevronDown}
                    className="h-4 w-4"
                  />
                </button>
                {running && (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                )}
                {editingId === workspace.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => setEditingId(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && draft.trim()) {
                        void store
                          .renameWorkspace(workspace.id, draft.trim())
                          .then(() => setEditingId(null));
                      }
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border bg-white px-1 dark:bg-neutral-900"
                  />
                ) : (
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium"
                    onClick={() => store.selectWorkspace(workspace.id)}
                    title={workspace.name}
                  >
                    {workspace.switchMode === "remote" && (
                      <span title={workspace.switchUrl}>
                        <AppIcon
                          icon={Cloud}
                          className="h-3.5 w-3.5 shrink-0 text-neutral-500"
                        />
                      </span>
                    )}
                    <span className="min-w-0 truncate">{workspace.name}</span>
                  </button>
                )}
                <span className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
                  <button
                    title="New session"
                    disabled={!available || workspace.status !== "active"}
                    onClick={() => void store.createSession(workspace.id)}
                    className="rounded p-1 text-neutral-500 hover:text-neutral-900 disabled:opacity-40 dark:hover:text-neutral-100"
                  >
                    <AppIcon icon={MessageSquarePlus} className="h-4 w-4" />
                  </button>
                  <button
                    title="Rename workspace"
                    onClick={() => {
                      setEditingId(workspace.id);
                      setDraft(workspace.name);
                    }}
                    className="rounded p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    <AppIcon icon={PencilLine} className="h-4 w-4" />
                  </button>
                  <button
                    title="Delete workspace"
                    className="rounded p-1 text-neutral-500 hover:text-red-600 dark:text-neutral-400"
                    onClick={() => {
                      setDeletingId(workspace.id);
                    }}
                  >
                    <AppIcon icon={Trash2} className="h-4 w-4" />
                  </button>
                </span>
              </div>
              {!displayCollapsed &&
                visibleSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    sessionId={session.id}
                    title={session.title}
                  />
                ))}
              {!displayCollapsed && hiddenSessionCount > 0 && (
                <button
                  className="ml-4 mt-1 w-[calc(100%-1rem)] rounded-md px-2 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  onClick={() =>
                    setExpandedSessionCounts((counts) => ({
                      ...counts,
                      [workspace.id]: visibleSessionCount + 10,
                    }))
                  }
                >
                  显示更多（还有 {hiddenSessionCount} 个）
                </button>
              )}
            </section>
          );
        })}
      </div>
      <UserSettingsPanel />
      {creating && (
        <Modal title="Create workspace" onClose={() => setCreating(false)}>
          <input
            autoFocus
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && createName.trim()) {
                void store
                  .createWorkspace(createName.trim(), createConnectionId)
                  .then(() => setCreating(false));
              }
              if (event.key === "Escape") setCreating(false);
            }}
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800"
          />
          <p className="text-xs text-neutral-500">
            Connection:{" "}
            {store.switchProfiles.find((profile) => profile.id === createConnectionId)?.name ??
              currentWorkspace?.connectionId ??
              "Local"}
          </p>
          <DialogActions
            onCancel={() => setCreating(false)}
            onConfirm={() => {
              if (createName.trim()) {
                void store
                  .createWorkspace(createName.trim(), createConnectionId)
                  .then(() => setCreating(false));
              }
            }}
            confirmLabel="Create"
            disabled={!createName.trim()}
          />
        </Modal>
      )}
      {deletingId && (() => {
        const workspace = store.workspaces.find((item) => item.id === deletingId);
        if (!workspace) return null;
        const count = store.sessions.filter(
          (session) => session.workspaceId === deletingId,
        ).length;
        return (
          <Modal title="Delete workspace" onClose={() => setDeletingId(null)}>
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              Delete workspace "{workspace.name}" and permanently remove its {count}{" "}
              session{count === 1 ? "" : "s"} and files?
            </p>
            <DialogActions
              danger
              onCancel={() => setDeletingId(null)}
              onConfirm={() => {
                void store.deleteWorkspace(deletingId).then(() => setDeletingId(null));
              }}
              confirmLabel="Delete permanently"
            />
          </Modal>
        );
      })()}
    </div>
  );
}

function SessionRow({ sessionId, title }: { sessionId: string; title: string }) {
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const running = useChatStore((state) => state.buckets[sessionId]?.runId != null);
  const selectSession = useChatStore((state) => state.selectSession);
  const renameSession = useChatStore((state) => state.renameSession);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  return (
    <div
      onClick={() => void selectSession(sessionId)}
      className={`group ml-4 mt-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        sessionId === currentSessionId
          ? "bg-neutral-200 dark:bg-neutral-700"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      {running && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) {
              void renameSession(sessionId, draft.trim()).then(() => setEditing(false));
            }
            if (event.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1 rounded border bg-white px-1 dark:bg-neutral-900"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
      )}
      <span className="ml-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
        <button
          title="Rename session"
          className="rounded p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          onClick={(event) => {
            event.stopPropagation();
            setDraft(title);
            setEditing(true);
          }}
        >
          <AppIcon icon={PencilLine} className="h-4 w-4" />
        </button>
        <button
          title="Delete session"
          className="rounded p-1 text-neutral-500 hover:text-red-600 dark:text-neutral-400"
          onClick={(event) => {
            event.stopPropagation();
            void deleteSession(sessionId);
          }}
        >
          <AppIcon icon={Trash2} className="h-4 w-4" />
        </button>
      </span>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-lg bg-white p-4 shadow-xl dark:bg-neutral-900"
      >
        <h2 className="font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function DialogActions({
  onCancel,
  onConfirm,
  confirmLabel,
  disabled = false,
  danger = false,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        onClick={onCancel}
        className="rounded px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Cancel
      </button>
      <button
        disabled={disabled}
        onClick={onConfirm}
        className={`rounded px-3 py-1.5 text-sm text-white disabled:opacity-40 ${
          danger
            ? "bg-red-600 hover:bg-red-700"
            : "bg-neutral-900 hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
