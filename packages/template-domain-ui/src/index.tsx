"use client";

import { ArrowUpRight, Boxes, Check, Circle, LoaderCircle } from "lucide-react";
import type { ChatPaneToolbarProps } from "silverretort-template-sdk";

function completedRunCount(messages: ChatPaneToolbarProps["messages"]) {
  return messages.filter(
    (message) => message.role === "assistant" && message.status === "complete",
  ).length;
}

export function DomainDesignToolbar(props: ChatPaneToolbarProps) {
  const steps = props.template.workflow?.steps;
  const completedCount = steps
    ? Math.min(completedRunCount(props.messages), steps.length)
    : 0;
  const activeIndex = steps
    ? Math.min(completedCount, steps.length - 1)
    : 0;

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
      {steps ? (
        <nav
          aria-label="工作流程"
          className="ml-auto flex min-w-0 items-center overflow-hidden"
        >
          {steps.map((step, index) => {
            const complete = index < completedCount;
            const active = index === activeIndex;
            const working = active && props.running;
            const StepIcon = complete ? Check : working ? LoaderCircle : Circle;
            return (
              <div key={step.id} className="flex min-w-0 items-center">
                {index > 0 && (
                  <span
                    aria-hidden="true"
                    className={`h-px w-2 shrink-0 sm:w-4 ${complete ? "bg-emerald-500" : "bg-neutral-200 dark:bg-neutral-700"}`}
                  />
                )}
                <button
                  type="button"
                  title={step.prompt}
                  aria-current={active ? "step" : undefined}
                  onClick={() => props.setDraft(step.prompt)}
                  disabled={!props.session || props.running}
                  className={`flex h-8 min-w-0 items-center gap-1.5 rounded px-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60 sm:px-2 ${
                    complete
                      ? "text-emerald-700 dark:text-emerald-400"
                      : active
                        ? "bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                        : "text-neutral-400 dark:text-neutral-500"
                  }`}
                >
                  <StepIcon
                    className={`h-3.5 w-3.5 shrink-0 ${working ? "animate-spin" : ""}`}
                  />
                  <span className="hidden truncate md:inline">{step.label}</span>
                </button>
              </div>
            );
          })}
        </nav>
      ) : (
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
      )}
    </header>
  );
}
