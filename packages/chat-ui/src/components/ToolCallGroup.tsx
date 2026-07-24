"use client";

import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  PanelRight,
  LoaderCircle,
  X,
} from "lucide-react";
import type { ToolCall } from "silverretort-protocol";
import { AppIcon } from "./icons";
import { getToolCallTodos, type ToolCallTodo } from "./toolCallGroupSupport";

export interface ToolCallGroupArtifact {
  id: string;
  title: string;
}

interface ToolCallGroupProps {
  toolCalls: ToolCall[];
  artifacts?: ToolCallGroupArtifact[];
  onOpenArtifact?: (artifactId: string) => void;
  showTodos?: boolean;
  children: ReactNode;
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

function TodoStatusIcon({ status }: { status: string }) {
  if (status === "completed" || status === "done") {
    return <AppIcon icon={Check} className="h-3.5 w-3.5 text-emerald-600" />;
  }
  if (status === "cancelled" || status === "canceled") {
    return <AppIcon icon={X} className="h-3.5 w-3.5 text-neutral-400" />;
  }
  if (status === "in_progress" || status === "running") {
    return (
      <AppIcon
        icon={LoaderCircle}
        className="h-3.5 w-3.5 animate-spin text-blue-500"
      />
    );
  }
  return <AppIcon icon={Circle} className="h-3.5 w-3.5 text-neutral-400" />;
}

function TodoList({ todos }: { todos: ToolCallTodo[] }) {
  if (todos.length === 0) {
    return null;
  }
  return (
    <div className="ml-2 mt-1 space-y-1 border-l border-neutral-200 pl-3 dark:border-neutral-700">
      {todos.map((todo, index) => (
        <div
          key={`${todo.text}:${index}`}
          className="flex items-start gap-1.5 text-xs text-neutral-600 dark:text-neutral-300"
        >
          <span className="mt-0.5 shrink-0">
            <TodoStatusIcon status={todo.status} />
          </span>
          <span
            className={
              ["completed", "done", "cancelled", "canceled"].includes(todo.status)
                ? "text-neutral-400 line-through"
                : ""
            }
          >
            {todo.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ToolCallGroup({
  toolCalls,
  artifacts = [],
  onOpenArtifact,
  showTodos = true,
  children,
}: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const todos = showTodos ? getToolCallTodos(toolCalls) : [];
  const summary =
    toolCalls.length === 1
      ? `调用了 ${toolCalls[0]?.name ?? "工具"}`
      : `调用了 ${toolCalls.length} 次工具`;

  return (
    <div className="my-1">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-left align-baseline hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <GroupStatusIcon status={aggregateStatus(toolCalls)} />
          <span className="text-xs text-neutral-600 dark:text-neutral-300">
            {summary}
          </span>
          <AppIcon
            icon={expanded ? ChevronDown : ChevronRight}
            className="h-4 w-4 shrink-0 text-neutral-400"
          />
        </button>
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            title={`打开 ${artifact.title}`}
            onClick={() => onOpenArtifact?.(artifact.id)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <AppIcon icon={PanelRight} className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <TodoList todos={todos} />
      {expanded && (
        <div className="mt-1 border-l border-neutral-200 pl-3 dark:border-neutral-700">
          {children}
        </div>
      )}
    </div>
  );
}
