"use client";

import { useChatStore } from "../store";

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
  const defaultProvider = sessionModel?.defaultProvider || "Default provider";
  const defaultLabel = sessionModel?.defaultModel
    ? shortModelName(sessionModel.defaultModel)
    : "Default model";
  const selectedModel = models.find((model) => model.id === value);
  const selectedProvider = selectedModel
    ? providerTitle(selectedModel.provider, selectedModel.providerLabel)
    : defaultProvider;
  const disabled = !currentSessionId || running || !available || models.length === 0;

  return (
    <label
      className="flex min-w-0 items-center rounded-full px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
      title={
        available
          ? `Model for this session · Provider: ${selectedProvider}`
          : "Hermes model controls unavailable"
      }
    >
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
        className="max-w-28 bg-transparent text-xs outline-none disabled:opacity-50"
        aria-label="Session model"
        title={`Provider: ${selectedProvider}`}
      >
        <option value="__default__" title={`Provider: ${defaultProvider}`}>
          {defaultLabel}
        </option>
        {models.map((model) => (
          <option
            key={model.id}
            value={model.id}
            disabled={!model.available}
            title={`Provider: ${providerTitle(model.provider, model.providerLabel)}`}
          >
            {shortModelName(model.model)}
          </option>
        ))}
      </select>
    </label>
  );
}

function shortModelName(model: string): string {
  return model.split("/").at(-1) || model || "model";
}

function providerTitle(provider: string, providerLabel: string): string {
  return providerLabel || provider || "Unknown provider";
}
