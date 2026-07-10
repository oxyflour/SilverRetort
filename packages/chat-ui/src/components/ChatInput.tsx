"use client";

import { useRef, useState } from "react";
import { useChatStore } from "../store";

export function ChatInput() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const running = useChatStore((s) =>
    s.currentSessionId ? s.buckets[s.currentSessionId]?.runId != null : false,
  );
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopRun = useChatStore((s) => s.stopRun);
  const addAttachment = useChatStore((s) => s.addAttachment);
  const removeAttachment = useChatStore((s) => s.removeAttachment);
  const [text, setText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmedText = text.trim();
  const canSubmit =
    Boolean(currentSessionId) &&
    !running &&
    (trimmedText.length > 0 || pendingAttachments.length > 0);

  const submit = () => {
    if (!canSubmit) return;
    setText("");
    void sendMessage(trimmedText);
  };

  return (
    <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          for (const file of e.target.files ?? []) void addAttachment(file);
          e.target.value = "";
        }}
      />
      <div className="mx-auto max-w-3xl">
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-neutral-50 px-3 py-1 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
              >
                <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                  {attachment.kind === "image" ? "IMG" : "FILE"}
                </span>
                <span className="max-w-52 truncate">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                  className="text-neutral-400 transition-colors hover:text-red-500"
                >
                  <CloseIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 rounded-[1.25rem] bg-neutral-100 px-3 py-2 transition-colors dark:bg-neutral-800">
          <button
            type="button"
            title="\u6dfb\u52a0\u9644\u4ef6"
            aria-label="\u6dfb\u52a0\u9644\u4ef6"
            onClick={() => fileInputRef.current?.click()}
            disabled={!currentSessionId}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:bg-neutral-100 focus-visible:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:focus-visible:bg-neutral-800 dark:focus-visible:text-neutral-100"
          >
            <PlusIcon />
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              for (const item of e.clipboardData.items) {
                const file = item.kind === "file" ? item.getAsFile() : null;
                if (file) void addAttachment(file);
              }
            }}
            placeholder={
              currentSessionId
                ? "\u8f93\u5165\u6d88\u606f\uff0cEnter \u53d1\u9001"
                : "\u5148\u65b0\u5efa\u4e00\u4e2a\u4f1a\u8bdd"
            }
            disabled={!currentSessionId}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400 disabled:opacity-40 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              title={running ? "\u505c\u6b62\u751f\u6210" : "\u53d1\u9001\u6d88\u606f"}
              aria-label={running ? "\u505c\u6b62\u751f\u6210" : "\u53d1\u9001\u6d88\u606f"}
              onClick={() =>
                running
                  ? currentSessionId && void stopRun(currentSessionId)
                  : submit()
              }
              disabled={running ? !currentSessionId : !canSubmit}
              className={
                running
                  ? "inline-flex h-8 items-center gap-2 rounded-full bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
                  : "flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
              }
            >
              {running ? (
                <>
                  <StopIcon />
                  <span>{"\u505c\u6b62"}</span>
                </>
              ) : (
                <SendIcon />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path
        d="M10 4.167v11.666M4.167 10h11.666"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path
        d="M10 15.833V4.167M5.833 8.333L10 4.167l4.167 4.166"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className="h-3.5 w-3.5"
    >
      <rect x="5" y="5" width="10" height="10" rx="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="h-3.5 w-3.5"
    >
      <path
        d="M6 6l8 8M14 6l-8 8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
