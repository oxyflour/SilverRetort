"use client";

import { Bot } from "lucide-react";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";

export function SessionModelSelector() {
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const models = useChatStore((state) => state.hermesModels);
  const sessionModel = useChatStore((state) =>
    state.currentSessionId ? state.sessionModels[state.currentSessionId] : undefined,
  );
  const available = useChatStore((state) => state.hermesControlsAvailable);
  const running = useChatStore((state) =>
    state.currentSessionId ? state.buckets[state.currentSessionId]?.runId != null : false,
  );
  const setSessionModel = useChatStore((state) => state.setSessionModel);
  const refreshHermesControls = useChatStore((state) => state.refreshHermesControls);

  const value = sessionModel?.source === "session" ? sessionModel.modelId : "__default__";
  const defaultLabel = sessionModel?.defaultModel
    ? `Default: ${shortModelName(sessionModel.defaultModel)}`
    : "Default model";
  const disabled = !currentSessionId || running || !available || models.length === 0;

  return (
    <label
      className="flex min-w-0 items-center gap-1 rounded-full px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
      title={available ? "Model for this session" : "Hermes model controls unavailable"}
    >
      <AppIcon icon={Bot} className="h-3.5 w-3.5 shrink-0" />
      <select
        value={value}
        disabled={disabled}
        onFocus={() => {
          if (models.length === 0) void refreshHermesControls();
        }}
        onChange={(event) => {
          if (!currentSessionId) return;
          const next = event.target.value;
          if (next === "__default__") {
            void setSessionModel(currentSessionId, null);
            return;
          }
          const selected = models.find((model) => model.id === next);
          if (selected) void setSessionModel(currentSessionId, selected);
        }}
        className="max-w-36 bg-transparent text-xs outline-none disabled:opacity-50"
        aria-label="Session model"
      >
        <option value="__default__">{defaultLabel}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id} disabled={!model.available}>
            {model.providerLabel || model.provider}: {shortModelName(model.model)}
          </option>
        ))}
      </select>
    </label>
  );
}

function shortModelName(model: string): string {
  return model.split("/").at(-1) || model || "model";
}
