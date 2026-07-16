"use client";

import { type HermesUsageResponse } from "silverretort-protocol";
import { useChatStore } from "../store";

export function ModelUsageRing() {
  const usage = useChatStore((state) => state.hermesUsage);
  const percent = usage?.available ? clampPercent(usage.percent) : null;
  const ringPercent = percent ?? 0;
  const color = usageColor(ringPercent, usage?.available ?? false);
  const summary = usageSummary(usage, percent);

  return (
    <span className="group relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
      <span
        aria-label={summary}
        title={summary}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(${color} ${ringPercent * 3.6}deg, rgb(212 212 212) 0deg)`,
        }}
      >
        <span className="h-2 w-2 rounded-full bg-neutral-100 dark:bg-neutral-800" />
      </span>
      <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-64 rounded-md border border-neutral-200 bg-white p-2 text-left text-xs text-neutral-700 shadow-lg group-hover:block group-focus-within:block dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
        <UsageDetails usage={usage} percent={percent} />
      </span>
    </span>
  );
}

function UsageDetails({
  usage,
  percent,
}: {
  usage: HermesUsageResponse | null;
  percent: number | null;
}) {
  if (!usage) {
    return <span>Usage data is not loaded.</span>;
  }

  return (
    <span className="block space-y-1">
      <span className="block font-medium text-neutral-900 dark:text-neutral-100">
        {usage.title || "Usage"}
        {percent !== null ? ` - ${Math.round(percent)}% used` : ""}
      </span>
      <span className="block truncate text-neutral-500 dark:text-neutral-400">
        {[usage.provider, shortModelName(usage.model)].filter(Boolean).join(" - ")}
      </span>
      {usage.windows.length > 0 ? (
        usage.windows.map((window) => (
          <span key={window.label} className="block">
            <span className="font-medium">{window.label}</span>
            {window.usedPercent !== null
              ? `: ${Math.round(window.usedPercent)}% used`
              : ": usage unknown"}
            {window.detail ? (
              <span className="block text-neutral-500 dark:text-neutral-400">
                {window.detail}
              </span>
            ) : null}
          </span>
        ))
      ) : (
        <span className="block">
          {usage.unavailableReason || "No usage window is available."}
        </span>
      )}
      {usage.details.slice(0, 4).map((detail) => (
        <span key={detail} className="block text-neutral-500 dark:text-neutral-400">
          {detail}
        </span>
      ))}
    </span>
  );
}

function usageSummary(
  usage: HermesUsageResponse | null,
  percent: number | null,
): string {
  if (!usage) {
    return "Usage data is not loaded";
  }
  if (percent === null) {
    return usage.unavailableReason || "Usage unavailable";
  }
  return `${usage.label || usage.title || "Usage"}: ${Math.round(percent)}% used`;
}

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function usageColor(percent: number, available: boolean): string {
  if (!available) {
    return "rgb(163 163 163)";
  }
  if (percent >= 90) {
    return "rgb(220 38 38)";
  }
  if (percent >= 75) {
    return "rgb(217 119 6)";
  }
  return "rgb(22 163 74)";
}

function shortModelName(model: string): string {
  return model.split("/").at(-1) || model;
}
