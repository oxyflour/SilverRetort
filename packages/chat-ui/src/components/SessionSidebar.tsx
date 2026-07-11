"use client";

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MessageSquarePlus,
  PencilLine,
  Trash2,
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const available = Boolean(
    store.workspaceCapability?.supported && store.workspaceCapability.writable,
  );

  return (
    <div className="flex h-full flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="space-y-2 p-2">
        <button
          disabled={!available}
          onClick={() => {
            setCreateName("New workspace");
            setCreating(true);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          <AppIcon icon={FolderPlus} className="h-4 w-4" />
          New workspace
        </button>
        {!available && store.workspaceCapability && (
          <p className="px-1 text-xs text-amber-600">
            Workspace support is unavailable in the current Hermes build.
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {store.workspaces.map((workspace) => {
          const sessions = store.sessions.filter(
            (session) => session.workspaceId === workspace.id,
          );
          const collapsed = store.collapsedWorkspaceIds.includes(workspace.id);
          const running = sessions.some(
            (session) => store.buckets[session.id]?.runId != null,
          );
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
                  onClick={() => store.toggleWorkspace(workspace.id)}
                  title={collapsed ? "Expand workspace" : "Collapse workspace"}
                >
                  <AppIcon
                    icon={collapsed ? ChevronRight : ChevronDown}
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
                    className="min-w-0 flex-1 truncate text-left font-medium"
                    onClick={() => store.selectWorkspace(workspace.id)}
                    title={workspace.name}
                  >
                    {workspace.name}
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
              {!collapsed &&
                sessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    sessionId={session.id}
                    title={session.title}
                  />
                ))}
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
                  .createWorkspace(createName.trim())
                  .then(() => setCreating(false));
              }
              if (event.key === "Escape") setCreating(false);
            }}
            className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-800"
          />
          <DialogActions
            onCancel={() => setCreating(false)}
            onConfirm={() => {
              if (createName.trim()) {
                void store
                  .createWorkspace(createName.trim())
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
