"use client";

import { type DragEvent, useMemo, useRef, useState } from "react";
import { Paperclip, SendHorizontal, Square, X } from "lucide-react";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";
import { SessionModelSelector } from "./SessionModelSelector";

interface ChatInputProps {
  text: string;
  onTextChange: (text: string) => void;
}

export function ChatInput({ text, onTextChange }: ChatInputProps) {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const running = useChatStore((s) =>
    s.currentSessionId ? s.buckets[s.currentSessionId]?.runId != null : false,
  );
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const artifactContexts = useChatStore((s) => s.artifactContexts);
  const artifacts = useChatStore((s) => s.artifacts);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopRun = useChatStore((s) => s.stopRun);
  const addAttachment = useChatStore((s) => s.addAttachment);
  const removeAttachment = useChatStore((s) => s.removeAttachment);
  const clearArtifactContext = useChatStore((s) => s.clearArtifactContext);
  const slashCommands = useChatStore((s) => s.slashCommands);
  const refreshHermesControls = useChatStore((s) => s.refreshHermesControls);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmedText = text.trim();
  const pendingArtifactContexts = useMemo(
    () =>
      Object.values(artifactContexts).filter(
        (context) => context.sessionId === currentSessionId,
      ),
    [artifactContexts, currentSessionId],
  );
  const canSubmit =
    Boolean(currentSessionId) &&
    !running &&
    (trimmedText.length > 0 || pendingAttachments.length > 0);

  const submit = () => {
    if (!canSubmit) return;
    onTextChange("");
    void sendMessage(trimmedText);
  };

  const slashSuggestions = useMemo(() => {
    const match = text.match(/^\/[A-Za-z0-9_-]*$/);
    if (!match) return [];
    const prefix = text.toLowerCase();
    return slashCommands
      .filter((command) => command.command.toLowerCase().startsWith(prefix))
      .slice(0, 8);
  }, [slashCommands, text]);

  const insertSlashCommand = (command: string) => {
    onTextChange(`${command} `);
  };

  const addFiles = (files: FileList | File[]) => {
    if (!currentSessionId) return;
    for (const file of Array.from(files)) void addAttachment(file);
  };

  const hasDraggedFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");

  return (
    <div
      className="p-3"
      onDragEnter={(event) => {
        if (!currentSessionId || !hasDraggedFiles(event)) return;
        event.preventDefault();
        setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!currentSessionId || !hasDraggedFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDraggingFiles(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!currentSessionId || !hasDraggedFiles(event)) return;
        event.preventDefault();
        setDraggingFiles(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="mx-auto max-w-3xl">
        {pendingArtifactContexts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingArtifactContexts.map((context) => (
              <span
                key={context.artifactId}
                className="inline-flex items-center gap-2 rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-xs text-blue-800 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
              >
                <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide dark:bg-blue-900/60">
                  CTX
                </span>
                <span className="max-w-52 truncate">
                  {context.displayText ??
                    artifacts[context.artifactId]?.title ??
                    context.action}
                </span>
                <button
                  type="button"
                  onClick={() => void clearArtifactContext(context.artifactId)}
                  aria-label={`Remove artifact context ${context.displayText ?? context.action}`}
                  className="text-blue-400 transition-colors hover:text-red-500"
                >
                  <AppIcon icon={X} className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <span
                key={`${attachment.workspaceId}:${attachment.relativePath}`}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-neutral-50 px-3 py-1 text-xs text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200"
              >
                <span className="rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                  {attachment.kind === "image" ? "IMG" : "FILE"}
                </span>
                <span className="max-w-52 truncate">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.workspaceId, attachment.relativePath)}
                  aria-label={`Remove ${attachment.name}`}
                  className="text-neutral-400 transition-colors hover:text-red-500"
                >
                  <AppIcon icon={X} className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className={`relative flex items-end gap-2 rounded-[1.25rem] border border-transparent bg-neutral-100 px-3 py-2 transition-colors dark:bg-neutral-800 ${
            draggingFiles
              ? "border-dashed border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/30"
              : ""
          }`}
        >
          {slashSuggestions.length > 0 && (
            <div className="absolute bottom-full left-10 right-3 mb-2 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {slashSuggestions.map((command) => (
                <button
                  key={command.command}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertSlashCommand(command.command);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span className="font-mono text-xs text-neutral-500">
                    {command.command}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-200">
                    {command.description || command.name}
                  </span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800">
                    {command.kind}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            title="\u6dfb\u52a0\u9644\u4ef6"
            aria-label="\u6dfb\u52a0\u9644\u4ef6"
            onClick={() => fileInputRef.current?.click()}
            disabled={!currentSessionId}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:bg-neutral-100 focus-visible:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:focus-visible:bg-neutral-800 dark:focus-visible:text-neutral-100"
          >
            <AppIcon icon={Paperclip} className="h-4 w-4" />
          </button>
          <div className="grid min-w-0 flex-1">
            <textarea
              rows={1}
              value={text}
              onChange={(e) => {
                const next = e.target.value;
                onTextChange(next);
                if (next === "/") void refreshHermesControls();
              }}
              onKeyDown={(e) => {
                if (e.key === "Tab" && slashSuggestions[0]) {
                  e.preventDefault();
                  insertSlashCommand(slashSuggestions[0].command);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.items).flatMap((item) => {
                  const file = item.kind === "file" ? item.getAsFile() : null;
                  return file ? [file] : [];
                });
                addFiles(files);
              }}
              placeholder={
                currentSessionId
                  ? "\u8f93\u5165\u6d88\u606f\uff0cEnter \u53d1\u9001"
                  : "\u5148\u65b0\u5efa\u4e00\u4e2a\u4f1a\u8bdd"
              }
              disabled={!currentSessionId}
              className="col-start-1 row-start-1 h-full min-h-8 max-h-[4.25rem] resize-none overflow-y-auto bg-transparent py-1 text-sm leading-5 text-neutral-900 outline-none placeholder:text-neutral-400 disabled:opacity-40 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            <div
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 min-h-8 max-h-[4.25rem] overflow-hidden whitespace-pre-wrap break-words py-1 text-sm leading-5"
            >
              {text ? `${text} ` : " "}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SessionModelSelector />
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
                  ? "flex h-8 w-8 items-center justify-center rounded-full bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
                  : "flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
              }
            >
              {running ? (
                <AppIcon icon={Square} className="h-3.5 w-3.5 fill-current" />
              ) : (
                <AppIcon icon={SendHorizontal} className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
