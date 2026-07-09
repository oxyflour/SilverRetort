"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Message, ToolCall } from "silverretort-protocol";
import { useChatStore } from "../store";

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
  const icon =
    toolCall.status === "running" ? "⏳" : toolCall.status === "done" ? "✓" : "✗";
  const detailText = toolCall.detail?.trim() ? toolCall.detail : "暂无详情";
  const resultText = toolCall.result?.trim() ? toolCall.result : "暂无返回结果";
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
          <span
            className={
              toolCall.status === "error"
                ? "text-red-500"
                : toolCall.status === "running"
                  ? "animate-pulse"
                  : "text-emerald-600"
            }
          >
            {icon}
          </span>
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
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded px-1 text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          {expanded ? "v" : ">"}
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
  const client = useChatStore((s) => s.client);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const artifacts = useChatStore((s) => s.artifacts);
  const sessionMessages = useChatStore(
    (state) => state.buckets[message.sessionId]?.messages ?? [],
  );
  const isUser = message.role === "user";
  const sessionArtifactIds = Object.values(artifacts)
    .filter((artifact) => artifact.sessionId === message.sessionId)
    .sort((left, right) => toTimestamp(left.createdAt) - toTimestamp(right.createdAt))
    .map((artifact) => artifact.id);
  const artifactCreatedAtById = Object.fromEntries(
    Object.values(artifacts).map((artifact) => [artifact.id, artifact.createdAt]),
  );

  return (
    <div className={`px-4 py-3 ${isUser ? "bg-neutral-100 dark:bg-neutral-800/60" : ""}`}>
      <div className="mx-auto max-w-3xl">
        <div className="mb-1 text-xs font-semibold text-neutral-500">
          {isUser ? "你" : "助手"}
          {message.status === "streaming" && (
            <span className="ml-2 animate-pulse text-emerald-600">生成中…</span>
          )}
          {message.status === "error" && (
            <span className="ml-2 text-red-500">出错了</span>
          )}
          {message.status === "stopped" && (
            <span className="ml-2 text-neutral-400">已停止</span>
          )}
        </div>

        {message.attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.attachments.map((a) =>
              a.kind === "image" ? (
                <img
                  key={a.id}
                  src={client.fileUrl(a.id)}
                  alt={a.name}
                  className="max-h-40 rounded-md border border-neutral-200 dark:border-neutral-700"
                />
              ) : (
                <a
                  key={a.id}
                  href={client.fileUrl(a.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
                >
                  📄 {a.name}
                </a>
              ),
            )}
          </div>
        )}

        {message.parts.map((part, i) =>
          part.type === "text" ? (
            <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
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
        )}

        {message.artifactIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.artifactIds.map((id) => (
              <button
                key={id}
                onClick={() => openArtifact(id, message.sessionId)}
                className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
              >
                🗔 {artifacts[id]?.title ?? "查看内容"}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
