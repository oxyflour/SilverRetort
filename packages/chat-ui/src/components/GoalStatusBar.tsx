"use client";

import { Pause, Play, Target, X } from "lucide-react";
import { useState } from "react";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";

export function GoalStatusBar() {
  const sessionId = useChatStore((state) => state.currentSessionId);
  const goal = useChatStore((state) =>
    state.currentSessionId
      ? state.goalStates[state.currentSessionId] ?? null
      : null,
  );
  const running = useChatStore((state) =>
    state.currentSessionId
      ? state.buckets[state.currentSessionId]?.runId != null
      : false,
  );
  const goalAction = useChatStore((state) => state.goalAction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sessionId || !goal) return null;

  const act = async (action: "pause" | "resume" | "clear") => {
    setBusy(true);
    setError(null);
    try {
      await goalAction(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const detail = goal.pausedReason || goal.lastReason;
  return (
    <div className="px-3 pt-2">
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
        <AppIcon icon={Target} className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-blue-950 dark:text-blue-100">
              {goal.objective}
            </span>
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-blue-700 dark:bg-blue-900 dark:text-blue-200">
              {goal.status}
            </span>
            <span className="shrink-0 text-xs text-blue-600/80 dark:text-blue-300/70">
              {goal.turnsUsed}/{goal.maxTurns}
            </span>
          </div>
          {(detail || error) && (
            <div className={`truncate text-xs ${error ? "text-red-600" : "text-blue-700/70 dark:text-blue-300/60"}`}>
              {error || detail}
            </div>
          )}
        </div>
        {goal.status === "active" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("pause")}
            title="Pause goal after the current turn"
            className="rounded-md p-1.5 text-blue-600 hover:bg-blue-100 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-900"
          >
            <AppIcon icon={Pause} className="h-3.5 w-3.5" />
          </button>
        )}
        {goal.status === "paused" && (
          <button
            type="button"
            disabled={busy || running}
            onClick={() => void act("resume")}
            title="Resume goal"
            className="rounded-md p-1.5 text-blue-600 hover:bg-blue-100 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-900"
          >
            <AppIcon icon={Play} className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("clear")}
          title="Clear goal"
          className="rounded-md p-1.5 text-blue-500 hover:bg-blue-100 hover:text-red-600 disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-900"
        >
          <AppIcon icon={X} className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
