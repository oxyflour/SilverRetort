"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Clock, Terminal } from "lucide-react";
import type { HermesBackgroundProcess } from "silverretort-protocol";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";

function formatUptime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) {
    return `${safeSeconds}s`;
  }
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function processLabel(process: HermesBackgroundProcess): string {
  return process.command.trim() || process.sessionId;
}

function statusClassName(process: HermesBackgroundProcess): string {
  if (process.status === "running") {
    return "bg-emerald-500";
  }
  if (process.exitCode === 0) {
    return "bg-neutral-400";
  }
  return "bg-red-500";
}

function ProcessRow({ process }: { process: HermesBackgroundProcess }) {
  const preview = process.outputPreview.trim();

  return (
    <div className="border-t border-neutral-200 px-3 py-2 first:border-t-0 dark:border-neutral-700">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${statusClassName(process)}`}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {processLabel(process)}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-500">
          {process.status}
          {process.status === "exited" && process.exitCode != null
            ? ` ${process.exitCode}`
            : ""}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
        <AppIcon icon={Clock} className="h-3 w-3" />
        <span>{formatUptime(process.uptimeSeconds)}</span>
        {process.pid != null && <span>pid {process.pid}</span>}
      </div>
      {preview && (
        <pre className="mt-2 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-100 px-2 py-1 font-mono text-[11px] text-neutral-600 dark:bg-neutral-950/60 dark:text-neutral-300">
          {preview}
        </pre>
      )}
    </div>
  );
}

export function HermesProcessFloat() {
  const runtime = useChatStore((state) => state.hermesRuntime);
  const [expanded, setExpanded] = useState(false);
  const processes = useMemo(
    () => runtime?.backgroundProcesses ?? [],
    [runtime?.backgroundProcesses],
  );

  if (processes.length === 0) {
    return null;
  }

  const runningCount = processes.filter(
    (process) => process.status === "running",
  ).length;
  const displayCount = runningCount > 0 ? runningCount : processes.length;
  const label =
    runningCount > 0
      ? `${runningCount} running`
      : `${processes.length} recent`;

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[min(22rem,calc(100%-1.5rem))]">
      <div className="pointer-events-auto overflow-hidden rounded-md border border-neutral-200 bg-white/95 text-neutral-900 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-100">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={`flex h-9 items-center gap-2 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
            expanded ? "w-full px-3" : "w-auto px-2.5"
          }`}
          aria-expanded={expanded}
          title="Hermes background processes"
        >
          <AppIcon icon={Terminal} className="h-4 w-4 shrink-0 text-neutral-500" />
          {expanded ? (
            <>
              <span className="min-w-0 flex-1 truncate font-medium">
                Background processes
              </span>
              <span className="shrink-0 text-neutral-500">{label}</span>
            </>
          ) : (
            <span className="min-w-0 font-medium tabular-nums">{displayCount}</span>
          )}
          <AppIcon
            icon={expanded ? ChevronUp : ChevronDown}
            className={`h-4 w-4 shrink-0 text-neutral-500 ${
              expanded ? "" : "hidden"
            }`}
          />
        </button>
        {expanded && (
          <div className="max-h-80 overflow-auto">
            {processes.map((process) => (
              <ProcessRow key={process.sessionId} process={process} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
