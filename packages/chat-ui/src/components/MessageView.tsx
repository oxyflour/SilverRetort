"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Message, ToolCall } from "silverretort-protocol";
import { useChatStore } from "../store";

function ToolCard({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const icon =
    toolCall.status === "running" ? "⏳" : toolCall.status === "done" ? "✓" : "✗";
  return (
    <div className="my-1 rounded-md border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-800/50">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
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
      </button>
      {expanded && toolCall.result && (
        <pre className="max-h-64 overflow-auto border-t border-neutral-200 px-3 py-2 text-xs dark:border-neutral-700">
          {toolCall.result}
        </pre>
      )}
    </div>
  );
}

export function MessageView({ message }: { message: Message }) {
  const client = useChatStore((s) => s.client);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const artifacts = useChatStore((s) => s.artifacts);
  const isUser = message.role === "user";

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
            <ToolCard key={part.toolCall.id} toolCall={part.toolCall} />
          ),
        )}

        {message.artifactIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.artifactIds.map((id) => (
              <button
                key={id}
                onClick={() => openArtifact(id)}
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
