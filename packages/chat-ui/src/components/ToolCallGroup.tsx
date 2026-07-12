"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import type { ToolCall } from "silverretort-protocol";
import { AppIcon } from "./icons";

interface ToolCallGroupProps {
  toolCalls: ToolCall[];
  children: ReactNode;
  inline?: boolean;
}

function aggregateStatus(toolCalls: ToolCall[]): ToolCall["status"] {
  if (toolCalls.some((toolCall) => toolCall.status === "running")) {
    return "running";
  }
  if (toolCalls.some((toolCall) => toolCall.status === "error")) {
    return "error";
  }
  return "done";
}

function GroupStatusIcon({ status }: { status: ToolCall["status"] }) {
  if (status === "running") {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
      />
    );
  }
  if (status === "error") {
    return <AppIcon icon={X} className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  return <AppIcon icon={Check} className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
}

export function ToolCallGroup({
  toolCalls,
  children,
  inline = false,
}: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={inline ? "inline" : "my-1"}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-left align-baseline hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <GroupStatusIcon status={aggregateStatus(toolCalls)} />
        <span className="text-xs text-neutral-600 dark:text-neutral-300">
          调用了 {toolCalls.length} 次工具
        </span>
        <AppIcon
          icon={expanded ? ChevronDown : ChevronRight}
          className="h-4 w-4 shrink-0 text-neutral-400"
        />
      </button>
      {expanded && (
        <div className="mt-1 border-l border-neutral-200 pl-3 dark:border-neutral-700">
          {children}
        </div>
      )}
    </div>
  );
}
