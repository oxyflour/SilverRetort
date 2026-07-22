"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, Bot, Clock, Package, Terminal } from "lucide-react";
import type {
  Artifact,
  HermesAsyncDelegation,
  HermesBackgroundProcess,
} from "silverretort-protocol";
import { useChatStore } from "../store";
import { AppIcon } from "./icons";
import { ToolbarIconBadge } from "./ToolbarIconBadge";

type PanelKind = "artifacts" | "processes" | "delegations";

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

function delegationStatusClassName(delegation: HermesAsyncDelegation): string {
  if (delegation.status === "running") {
    return "bg-sky-500";
  }
  if (["completed", "success"].includes(delegation.status)) {
    return "bg-neutral-400";
  }
  return "bg-red-500";
}

function IconBadgeButton({
  active,
  count,
  icon,
  title,
  onClick,
}: {
  active: boolean;
  count: number;
  icon: typeof Terminal;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={`relative flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ${
        active ? "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100" : ""
      }`}
    >
      <ToolbarIconBadge icon={icon} count={count} />
    </button>
  );
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

function delegationLabel(delegation: HermesAsyncDelegation): string {
  return delegation.goal.trim() || delegation.id;
}

function DelegationRow({ delegation }: { delegation: HermesAsyncDelegation }) {
  const duration =
    delegation.durationSeconds == null
      ? ""
      : formatUptime(delegation.durationSeconds);

  return (
    <div className="border-t border-neutral-200 px-3 py-2 first:border-t-0 dark:border-neutral-700">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${delegationStatusClassName(delegation)}`}
        />
        <span className="min-w-0 flex-1 truncate text-[11px]">
          {delegationLabel(delegation)}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-500">
          {delegation.status || "unknown"}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
        <AppIcon icon={Clock} className="h-3 w-3" />
        {duration && <span>{duration}</span>}
        {delegation.isBatch && <span>{delegation.taskCount} tasks</span>}
        {delegation.role && <span>{delegation.role}</span>}
        {delegation.model && <span className="truncate">{delegation.model}</span>}
      </div>
    </div>
  );
}

function ArtifactRow({
  artifact,
  onOpen,
}: {
  artifact: Artifact;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={artifact.title}
      onClick={onOpen}
      className="flex w-full items-center gap-2 border-t border-neutral-200 px-3 py-2 text-left text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      <AppIcon
        icon={Package}
        className="h-3.5 w-3.5 shrink-0 text-neutral-400"
      />
      <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
      <AppIcon
        icon={ArrowUpRight}
        className="h-3.5 w-3.5 shrink-0 text-neutral-400"
      />
    </button>
  );
}

export function ToolbarActivityMenu({ artifacts }: { artifacts: Artifact[] }) {
  const runtime = useChatStore((state) => state.hermesRuntime);
  const openArtifact = useChatStore((state) => state.openArtifact);
  const [activePanel, setActivePanel] = useState<PanelKind | null>(null);
  const processes = useMemo(
    () => runtime?.backgroundProcesses ?? [],
    [runtime?.backgroundProcesses],
  );
  const delegations = useMemo(
    () => runtime?.asyncDelegations ?? [],
    [runtime?.asyncDelegations],
  );

  const runningCount = processes.filter(
    (process) => process.status === "running",
  ).length;
  const runningDelegationCount = delegations.filter(
    (delegation) => delegation.status === "running",
  ).length;
  const processCount =
    runningCount > 0
      ? runningCount
      : Math.max(processes.length, runtime?.backgroundProcessCount ?? 0);
  const delegationCount =
    runningDelegationCount > 0
      ? runningDelegationCount
      : Math.max(delegations.length, runtime?.asyncDelegationCount ?? 0);
  const showProcesses = processCount > 0;
  const showDelegations = delegationCount > 0;
  const showArtifacts = artifacts.length > 0;

  if (!showArtifacts && !showProcesses && !showDelegations) {
    return null;
  }

  const activeArtifacts = activePanel === "artifacts";
  const activeProcesses = activePanel === "processes" && processes.length > 0;
  const activeDelegations =
    activePanel === "delegations" && delegations.length > 0;
  const panelTitle = activeArtifacts
    ? "产物"
    : activeProcesses
      ? "Background processes"
      : "Background subagents";
  const panelOpen = activeArtifacts || activeProcesses || activeDelegations;

  return (
    <div className="relative z-20 flex h-12 items-center bg-white pr-3 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <div className="flex gap-1">
        {showArtifacts && (
          <IconBadgeButton
            active={activeArtifacts}
            count={artifacts.length}
            icon={Package}
            title={`${artifacts.length} 项产物`}
            onClick={() =>
              setActivePanel((value) =>
                value === "artifacts" ? null : "artifacts",
              )
            }
          />
        )}
        {showProcesses && (
          <IconBadgeButton
            active={activeProcesses}
            count={processCount}
            icon={Terminal}
            title="Hermes background processes"
            onClick={() =>
              setActivePanel((value) =>
                value === "processes" ? null : "processes",
              )
            }
          />
        )}
        {showDelegations && (
          <IconBadgeButton
            active={activeDelegations}
            count={delegationCount}
            icon={Bot}
            title="Hermes background subagents"
            onClick={() =>
              setActivePanel((value) =>
                value === "delegations" ? null : "delegations",
              )
            }
          />
        )}
      </div>
      {panelOpen && (
        <div className="absolute right-3 top-full mt-1 max-h-80 w-[min(22rem,calc(100vw-1.5rem))] overflow-auto rounded-md border border-neutral-200 bg-white/95 text-neutral-900 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-100">
          <div className="px-3 py-2 text-xs font-medium text-neutral-500">
            {panelTitle}
          </div>
          {activeArtifacts &&
            artifacts.map((artifact) => (
              <ArtifactRow
                key={artifact.id}
                artifact={artifact}
                onOpen={() => {
                  openArtifact(artifact.id, artifact.sessionId);
                  setActivePanel(null);
                }}
              />
            ))}
          {activeProcesses &&
            processes.map((process) => (
              <ProcessRow key={process.sessionId} process={process} />
            ))}
          {activeDelegations &&
            delegations.map((delegation) => (
              <DelegationRow key={delegation.id} delegation={delegation} />
            ))}
        </div>
      )}
    </div>
  );
}
