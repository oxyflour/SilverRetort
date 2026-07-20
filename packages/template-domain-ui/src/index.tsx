"use client";

import { Activity, ArrowUpRight, Boxes } from "lucide-react";
import type { ChatPaneToolbarProps } from "silverretort-template-sdk";

function designStatus({
  running,
  messages,
  artifacts,
}: Pick<ChatPaneToolbarProps, "running" | "messages" | "artifacts">) {
  if (running) return "设计处理中";
  if (artifacts.length > 0) return `已有 ${artifacts.length} 项设计产物`;
  if (messages.length > 0) return "设计进行中";
  return "待开始";
}

export function DomainDesignToolbar(props: ChatPaneToolbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex min-w-0 items-center gap-2">
        <Boxes className="h-4 w-4 shrink-0 text-emerald-600" />
        <span className="truncate text-sm font-semibold">{props.template.name}</span>
        {props.session && (
          <span className="hidden truncate text-xs text-neutral-400 lg:inline">
            {props.session.title}
          </span>
        )}
      </div>
      <div className="inline-flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
        <Activity
          className={`h-3.5 w-3.5 ${props.running ? "animate-pulse text-emerald-600" : ""}`}
        />
        {designStatus(props)}
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-1">
        {props.template.emptyState.suggestions.slice(0, 3).map((suggestion) => (
          <button
            key={`${suggestion.label}:${suggestion.prompt}`}
            type="button"
            title={suggestion.label}
            onClick={() => props.setDraft(suggestion.prompt)}
            disabled={!props.session || props.running}
            className="inline-flex h-8 min-w-0 max-w-40 items-center gap-1 rounded px-2 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <span className="truncate">{suggestion.label}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
          </button>
        ))}
      </div>
    </header>
  );
}
