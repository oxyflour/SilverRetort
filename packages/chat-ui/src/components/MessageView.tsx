"use client";

import { memo, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Message, MessagePart, ToolCall } from "silverretort-protocol";
import { openArtifactInNewWindow } from "../openArtifactInNewWindow";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";
import {
  collapsedDetail,
  getShownArtifactId,
  groupConsecutiveToolCalls,
  inferArtifactIdFromMessageWindow,
  messageText,
  MessageViewProps,
  toRestartErrorMessage,
} from "./messageViewSupport";
import { ToolCallGroup } from "./ToolCallGroup";
import { ToolCallPayloadView } from "./ToolCallPayloadView";
import { MessageHeader } from "./MessageHeader";
import { hasTodoMerge, isTodoTool } from "./toolCallGroupSupport";

const markdownRemarkPlugins = [remarkGfm];
const markdownRehypePlugins = [rehypeHighlight];
const messageMarkdownComponents: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
    />
  ),
};
type ArtifactContextMessagePart = Extract<
  MessagePart,
  { type: "artifact-input" | "artifact-context" }
>;

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
  const [fullToolCall, setFullToolCall] = useState<ToolCall | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const client = useChatStore((state) => state.client);
  const openArtifact = useChatStore((state) => state.openArtifact);
  const displayedToolCall = fullToolCall ?? toolCall;
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
        <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ToolStatusIcon status={toolCall.status} />
          <span className={ `font-mono text-xs ${
            shownArtifactId ? "cursor-pointer" : "cursor-default"
          }` } onClick={() => { shownArtifactId && openArtifact(shownArtifactId, sessionId) }}>
            {toolCall.name}
          </span>
          {toolCall.detail && (
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
              {collapsedDetail(toolCall.detail)}
            </span>
          )}
          {shownArtifactId && (
            <button
              type="button"
              title="Open in new window"
              onClick={() => openArtifactInNewWindow(shownArtifactId)}
              className="border-l border-neutral-300 px-2 py-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <AppIcon icon={ExternalLink} className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
        <button
          type="button"
          aria-label={`Toggle details for ${toolCall.name}`}
          aria-expanded={expanded}
          onClick={() => {
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            if (
              nextExpanded &&
              !fullToolCall &&
              !loadingDetails &&
              (toolCall.detailTruncated || toolCall.resultTruncated)
            ) {
              setLoadingDetails(true);
              void client
                .getToolCall(sessionId, message.id, toolCall.id)
                .then(setFullToolCall)
                .catch(() => undefined)
                .finally(() => setLoadingDetails(false));
            }
          }}
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
            <ToolCallPayloadView
              value={displayedToolCall.detail}
              emptyText="No details"
              maxHeightClassName="max-h-32"
            />
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-neutral-500">
              result
            </div>
            <ToolCallPayloadView
              value={loadingDetails ? "Loading full details…" : displayedToolCall.result}
              emptyText="No result"
              maxHeightClassName="max-h-64"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MessageViewComponent({
  message,
  context,
}: MessageViewProps) {
  const client = useChatStore((state) => state.client);
  const openArtifact = useChatStore((state) => state.openArtifact);
  const closeArtifact = useChatStore((state) => state.closeArtifact);
  const restartFromMessage = useChatStore((state) => state.restartFromMessage);
  const {
    artifacts,
    running,
    sessionMessages,
    sessionArtifactIds,
    artifactCreatedAtById,
  } = context;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fullToolCalls, setFullToolCalls] = useState<Record<string, ToolCall>>({});
  const isUser = message.role === "user";
  const canRestart =
    isUser &&
    message.parts.some((part) => part.type === "text") &&
    message.parts.every(
      (part) =>
        part.type === "text" ||
        part.type === "artifact-context" ||
        part.type === "artifact-input",
    );
  const artifactContextParts = message.parts.filter(
    (part): part is ArtifactContextMessagePart =>
      part.type === "artifact-context" || part.type === "artifact-input",
  );
  const contentParts = message.parts.filter(
    (part) => part.type !== "artifact-context" && part.type !== "artifact-input",
  );
  const partGroups = groupConsecutiveToolCalls(contentParts);
  const lastToolGroupIndex = partGroups.findLast(
    (group) => group.type === "tools",
  )?.index;
  const mergedTodoGroupIndex = (() => {
    let hasMergedTodo = false;
    let lastTodoGroupIndex: number | null = null;

    for (const group of partGroups) {
      if (group.type !== "tools") {
        continue;
      }
      const toolCalls = group.toolCalls.map(
        (toolCall) => fullToolCalls[toolCall.id] ?? toolCall,
      );
      if (!toolCalls.some((toolCall) => isTodoTool(toolCall.name))) {
        continue;
      }
      if (toolCalls.some(hasTodoMerge)) {
        hasMergedTodo = true;
      }
      lastTodoGroupIndex = group.index;
    }

    return hasMergedTodo ? lastTodoGroupIndex : null;
  })();

  useEffect(() => {
    const lastTodoCall = message.parts.findLast(
      (part): part is Extract<MessagePart, { type: "tool" }> =>
        part.type === "tool" && isTodoTool(part.toolCall.name),
    )?.toolCall;
    if (
      !lastTodoCall ||
      fullToolCalls[lastTodoCall.id] ||
      (!lastTodoCall.detailTruncated && !lastTodoCall.resultTruncated)
    ) {
      return;
    }

    let active = true;
    void client
      .getToolCall(message.sessionId, message.id, lastTodoCall.id)
      .then((toolCall) => {
        if (!active) {
          return;
        }
        setFullToolCalls((current) => ({
          ...current,
          [toolCall.id]: toolCall,
        }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, fullToolCalls, message.id, message.parts, message.sessionId]);

  const copyMessage = () => {
    void navigator.clipboard.writeText(messageText(message));
  };

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
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 160px" }}
      className={`group px-4 py-3 ${
        isUser ? "bg-neutral-100 dark:bg-neutral-800/60" : ""
      }`}
    >
      <div className="mx-auto max-w-3xl">
        <MessageHeader
          message={message}
          running={running}
          saving={saving}
          editing={editing}
          canRestart={canRestart}
          onCopy={copyMessage}
          onRestart={beginEditing}
        />

        {(message.attachments.length > 0 || artifactContextParts.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.attachments.map((attachment) =>
              attachment.kind === "image" ? (
                <img
                  key={`${attachment.workspaceId}:${attachment.relativePath}`}
                  src={client.fileUrl(attachment.workspaceId, attachment.relativePath)}
                  alt={attachment.name}
                  className="max-h-40 rounded-md border border-neutral-200 dark:border-neutral-700"
                />
              ) : (
                <a
                  key={`${attachment.workspaceId}:${attachment.relativePath}`}
                  href={client.fileUrl(attachment.workspaceId, attachment.relativePath)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  {attachment.name}
                </a>
              ),
            )}
            {artifactContextParts.map((part) => (
              <span
                key={
                  part.type === "artifact-context"
                    ? `${part.artifactId}:${part.revision}`
                    : `${part.artifactId}:${part.submissionId}`
                }
                title={`${part.action}\n${JSON.stringify(part.data, null, 2)}`}
                className="inline-flex max-w-full items-center gap-2 self-start rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-xs text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
              >
                <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide dark:bg-blue-900/60">
                  CTX
                </span>
                <button
                  type="button"
                  onClick={() => openArtifact(part.artifactId, message.sessionId)}
                  className="max-w-72 truncate hover:text-blue-950 dark:hover:text-white"
                >
                  {part.displayText ??
                    artifacts[part.artifactId]?.title ??
                    part.action}
                </button>
              </span>
            ))}
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
          partGroups.map((group, groupIndex) => {
            const previousGroup = partGroups[groupIndex - 1];
            if (group.type === "tools" && previousGroup?.type === "text") {
              return null;
            }

            const nextGroup = partGroups[groupIndex + 1];
            const toolGroup =
              group.type === "tools"
                ? group
                : group.type === "text" && nextGroup?.type === "tools"
                  ? nextGroup
                  : null;
            const displayedToolCalls =
              toolGroup?.toolCalls.map(
                (toolCall) => fullToolCalls[toolCall.id] ?? toolCall,
              ) ?? [];
            const toolGroupArtifacts = toolGroup
              ? Array.from(
                  new Set(
                    [
                      ...toolGroup.toolCalls.map(
                        (toolCall) =>
                          getShownArtifactId(toolCall) ??
                          inferArtifactIdFromMessageWindow(
                            toolCall,
                            message,
                            sessionMessages,
                            sessionArtifactIds,
                            artifactCreatedAtById,
                          ),
                      ),
                      ...(toolGroup.index === lastToolGroupIndex
                        ? message.artifactIds
                        : []),
                    ].filter((artifactId): artifactId is string => Boolean(artifactId)),
                  ),
                ).map((artifactId) => ({
                  id: artifactId,
                  title: artifacts[artifactId]?.title ?? "Artifact",
                }))
              : [];

            return (
              <div key={group.index}>
                {group.type === "text" && (
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown
                      remarkPlugins={markdownRemarkPlugins}
                      rehypePlugins={markdownRehypePlugins}
                      components={messageMarkdownComponents}
                    >
                      {group.part.text}
                    </ReactMarkdown>
                  </div>
                )}
                {toolGroup && (
                  <ToolCallGroup
                    toolCalls={displayedToolCalls}
                    artifacts={toolGroupArtifacts}
                    showTodos={
                      mergedTodoGroupIndex === null ||
                      toolGroup.index === mergedTodoGroupIndex
                    }
                    onOpenArtifact={(artifactId) =>
                      openArtifact(artifactId, message.sessionId)
                    }
                  >
                    {toolGroup.toolCalls.map((toolCall) => (
                      <ToolCard
                        key={toolCall.id}
                        toolCall={toolCall}
                        message={message}
                        sessionMessages={sessionMessages}
                        sessionArtifactIds={sessionArtifactIds}
                        artifactCreatedAtById={artifactCreatedAtById}
                        sessionId={message.sessionId}
                      />
                    ))}
                  </ToolCallGroup>
                )}
              </div>
            );
          })
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

export const MessageView = memo(MessageViewComponent);
