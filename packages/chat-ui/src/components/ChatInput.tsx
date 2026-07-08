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

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || running || !currentSessionId) return;
    setText("");
    void sendMessage(trimmed);
  };

  return (
    <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
      {pendingAttachments.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
          {pendingAttachments.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1 rounded-full border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-600"
            >
              {a.kind === "image" ? "🖼" : "📄"} {a.name}
              <button
                onClick={() => removeAttachment(a.id)}
                className="ml-1 text-neutral-400 hover:text-red-500"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
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
        <button
          title="添加附件"
          onClick={() => fileInputRef.current?.click()}
          disabled={!currentSessionId}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          📎
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          placeholder={currentSessionId ? "输入消息，Enter 发送，Shift+Enter 换行" : "先新建一个会话"}
          disabled={!currentSessionId}
          className="flex-1 resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-40 dark:border-neutral-600 dark:bg-neutral-900"
        />
        {running ? (
          <button
            onClick={() => currentSessionId && void stopRun(currentSessionId)}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
          >
            停止
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() || !currentSessionId}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
