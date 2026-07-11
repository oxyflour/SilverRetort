"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  PencilLine,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Message, ToolCall } from "silverretort-protocol";
import { openArtifactInNewWindow } from "../openArtifactInNewWindow";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";

function isShowArtifactTool(toolName: string): boolean {
  return toolName.includes("ui_show_artifact");
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function parseArtifactResult(result: string | null | undefined): string | null {
  const trimmed = result?.trim();
  if (!trimmed || trimmed.startsWith("error:")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      const artifactId =
        "artifactId" in parsed
          ? parsed.artifactId
          : "id" in parsed
            ? parsed.id
            : null;
      return typeof artifactId === "string" ? artifactId : null;
    }
  } catch {
    // Plain string result is still valid.
  }

  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted || null;
}

function inferArtifactIdFromMessageWindow(
  toolCall: ToolCall,
  message: Message,
  sessionMessages: Message[],
  sessionArtifactIds: string[],
  artifactCreatedAtById: Record<string, string>,
): string | null {
  if (!isShowArtifactTool(toolCall.name)) {
    return null;
  }

  const explicitArtifactId = parseArtifactResult(toolCall.result);
  if (explicitArtifactId) {
    return explicitArtifactId;
  }

  if (message.artifactIds.length > 0) {
    return message.artifactIds[0] ?? null;
  }

  const currentMessageIndex = sessionMessages.findIndex(
    (currentMessage) => currentMessage.id === message.id,
  );
  const currentTimestamp = toTimestamp(message.createdAt);
  const nextTimestamp =
    currentMessageIndex >= 0 && currentMessageIndex + 1 < sessionMessages.length
      ? toTimestamp(sessionMessages[currentMessageIndex + 1]!.createdAt)
      : Number.POSITIVE_INFINITY;

  const matchingArtifacts = sessionArtifactIds.filter((artifactId) => {
    const createdAt = artifactCreatedAtById[artifactId];
    if (!createdAt) {
      return false;
    }
    const artifactTimestamp = toTimestamp(createdAt);
    return artifactTimestamp >= currentTimestamp && artifactTimestamp < nextTimestamp;
  });

  return matchingArtifacts[0] ?? null;
}

function getShownArtifactId(toolCall: ToolCall): string | null {
  if (toolCall.status !== "done") {
    return null;
  }
  return parseArtifactResult(toolCall.result);
}

function messageText(message: Message): string {
  return message.parts.reduce(
    (text, part) => (part.type === "text" ? text + part.text : text),
    "",
  );
}

function toRestartErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Save failed. Please try again.";
  }
  if (error.message.includes("HTTP 409")) {
    return "This session is still running. Try again after it stops.";
  }
  if (error.message.includes("HTTP 400")) {
    return "Only user messages can be edited and restarted.";
  }
  if (error.message.includes("HTTP 404")) {
    return "The target message no longer exists.";
  }
  return error.message;
}

function ToolStatusIcon({ status }: { status: ToolCall["status"] }) {
  if (status === "running") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
      />
    );
  }

  if (status === "done") {
    return <AppIcon icon={Check} className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
  }

  return <AppIcon icon={X} className="h-3.5 w-3.5 shrink-0 text-red-500" />;
}

function ToolCard({
  toolCall,
  message,
  sessionMessages,
  sessionArtifactIds,
  artifactCreatedAtById,
  sessionId,
}: {
  toolCall: ToolCall;
  message: Message;
  sessionMessages: Message[];
  sessionArtifactIds: string[];
  artifactCreatedAtById: Record<string, string>;
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const openArtifact = useChatStore((state) => state.openArtifact);
  const detailText = toolCall.detail?.trim() ? toolCall.detail : "No details";
  const resultText = toolCall.result?.trim() ? toolCall.result : "No result";
  const shownArtifactId =
    getShownArtifactId(toolCall) ??
    inferArtifactIdFromMessageWindow(
      toolCall,
      message,
      sessionMessages,
      sessionArtifactIds,
      artifactCreatedAtById,
    );

  return (
    <div className="my-1 rounded-md border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-800/50">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => {
            if (shownArtifactId) {
              openArtifact(shownArtifactId, sessionId);
            }
          }}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
            shownArtifactId ? "cursor-pointer" : "cursor-default"
          }`}
        >
          <ToolStatusIcon status={toolCall.status} />
          <span className="font-mono text-xs">{toolCall.name}</span>
          {toolCall.detail && (
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
              {toolCall.detail}
            </span>
          )}
          {shownArtifactId && (
            <span className="shrink-0 text-[11px] text-neutral-400">
              open artifact
            </span>
          )}
        </button>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="shrink-0 rounded p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <AppIcon
            icon={expanded ? ChevronDown : ChevronRight}
            className="h-4 w-4"
          />
        </button>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-neutral-200 px-3 py-2 text-xs dark:border-neutral-700">
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-neutral-500">
              status
            </div>
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-white/70 px-2 py-1 dark:bg-neutral-900/60">
              {toolCall.status}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-neutral-500">
              detail
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-white/70 px-2 py-1 dark:bg-neutral-900/60">
              {detailText}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-neutral-500">
              result
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white/70 px-2 py-1 dark:bg-neutral-900/60">
              {resultText}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function MessageView({ message }: { message: Message }) {
  const client = useChatStore((state) => state.client);
  const openArtifact = useChatStore((state) => state.openArtifact);
  const closeArtifact = useChatStore((state) => state.closeArtifact);
  const restartFromMessage = useChatStore((state) => state.restartFromMessage);
  const artifacts = useChatStore((state) => state.artifacts);
  const sessionMessages = useChatStore(
    (state) => state.buckets[message.sessionId]?.messages ?? [],
  );
  const running = useChatStore(
    (state) => state.buckets[message.sessionId]?.runId != null,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isUser = message.role === "user";
  const sessionArtifactIds = Object.values(artifacts)
    .filter((artifact) => artifact.sessionId === message.sessionId)
    .sort((left, right) => toTimestamp(left.createdAt) - toTimestamp(right.createdAt))
    .map((artifact) => artifact.id);
  const artifactCreatedAtById = Object.fromEntries(
    Object.values(artifacts).map((artifact) => [artifact.id, artifact.createdAt]),
  );
  const messageIndex = sessionMessages.findIndex(
    (currentMessage) => currentMessage.id === message.id,
  );
  const hasFollowingMessages =
    messageIndex >= 0 && messageIndex < sessionMessages.length - 1;

  const beginEditing = () => {
    setDraft(messageText(message));
    setSubmitError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (saving) {
      return;
    }
    setEditing(false);
    setDraft("");
    setSubmitError(null);
  };

  const popOutArtifact = (artifactId: string) => {
    if (openArtifactInNewWindow(artifactId)) {
      closeArtifact(artifactId);
    }
  };

  const submitRestart = async () => {
    const trimmed = draft.trim();
    if (!trimmed || saving || running) {
      return;
    }
    if (
      hasFollowingMessages &&
      !window.confirm(
        "Later messages and generated content will be removed. Save and restart?",
      )
    ) {
      return;
    }

    setSaving(true);
    setSubmitError(null);
    try {
      await restartFromMessage(message.id, trimmed);
      setEditing(false);
      setDraft("");
    } catch (error) {
      setSubmitError(toRestartErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`group px-4 py-3 ${
        isUser ? "bg-neutral-100 dark:bg-neutral-800/60" : ""
      }`}
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-neutral-500">
          <span>{isUser ? "User" : "Assistant"}</span>
          {message.status === "streaming" && (
            <span className="animate-pulse text-emerald-600">Streaming</span>
          )}
          {message.status === "error" && <span className="text-red-500">Error</span>}
          {message.status === "stopped" && (
            <span className="text-neutral-400">Stopped</span>
          )}
          {isUser && (
            <span className="ml-auto flex shrink-0 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
              <button
                type="button"
                title="Edit and restart"
                onClick={beginEditing}
                disabled={running || saving || editing}
                className="rounded p-1 text-neutral-500 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-neutral-100"
              >
                <AppIcon icon={PencilLine} className="h-4 w-4" />
              </button>
            </span>
          )}
        </div>

        {message.attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.attachments.map((attachment) =>
              attachment.kind === "image" ? (
                <img
                  key={attachment.id}
                  src={client.fileUrl(attachment.workspaceId, attachment.id)}
                  alt={attachment.name}
                  className="max-h-40 rounded-md border border-neutral-200 dark:border-neutral-700"
                />
              ) : (
                <a
                  key={attachment.id}
                  href={client.fileUrl(attachment.workspaceId, attachment.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  file {attachment.name}
                </a>
              ),
            )}
          </div>
        )}

        {editing ? (
          <div className="rounded-md border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900/70">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submitRestart();
                }
              }}
              rows={Math.min(8, Math.max(3, draft.split("\n").length))}
              disabled={saving}
              className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-950"
            />
            <div className="mt-2 text-xs text-neutral-500">
              Editing currently supports text only. Existing attachments stay unchanged.
            </div>
            {submitError && (
              <div className="mt-2 text-xs text-red-500">{submitError}</div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelEditing}
                disabled={saving}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitRestart()}
                disabled={!draft.trim() || saving || running}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                {saving ? "Restarting..." : "Save and restart"}
              </button>
            </div>
          </div>
        ) : (
          message.parts.map((part, index) =>
            part.type === "text" ? (
              <div key={index} className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                >
                  {part.text}
                </ReactMarkdown>
              </div>
            ) : (
              <ToolCard
                key={part.toolCall.id}
                toolCall={part.toolCall}
                message={message}
                sessionMessages={sessionMessages}
                sessionArtifactIds={sessionArtifactIds}
                artifactCreatedAtById={artifactCreatedAtById}
                sessionId={message.sessionId}
              />
            ),
          )
        )}

        {message.artifactIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.artifactIds.map((artifactId) => (
              <div
                key={artifactId}
                className="flex items-center overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-600"
              >
                <button
                  type="button"
                  onClick={() => openArtifact(artifactId, message.sessionId)}
                  className="px-3 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {artifacts[artifactId]?.title ?? "View artifact"}
                </button>
                <button
                  type="button"
                  title="Open in new window"
                  onClick={() => popOutArtifact(artifactId)}
                  className="border-l border-neutral-300 px-2 py-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                >
                  <AppIcon icon={ExternalLink} className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
