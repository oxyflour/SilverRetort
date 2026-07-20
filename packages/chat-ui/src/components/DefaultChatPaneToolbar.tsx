import { Activity, FolderKanban } from "lucide-react";
import type {
  Artifact,
  Message,
  Session,
  Workspace,
  WorkspaceTemplate,
} from "silverretort-protocol";
import { AppIcon } from "./icons";

interface DefaultChatPaneToolbarProps {
  workspace: Workspace;
  template?: WorkspaceTemplate;
  session: Session | null;
  messages: Message[];
  artifacts: Artifact[];
  running: boolean;
}

function currentStatus({
  running,
  messages,
  artifacts,
}: Pick<DefaultChatPaneToolbarProps, "running" | "messages" | "artifacts">) {
  if (running) return "处理中";
  if (artifacts.length > 0) return `${artifacts.length} 项产物`;
  if (messages.length > 0) return "进行中";
  return "待开始";
}

export function DefaultChatPaneToolbar(props: DefaultChatPaneToolbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4 dark:border-neutral-800 dark:bg-neutral-900">
      <AppIcon icon={FolderKanban} className="h-4 w-4 shrink-0 text-neutral-500" />
      <span className="truncate text-sm font-semibold">{props.workspace.name}</span>
      {props.template && (
        <span className="hidden truncate text-xs text-neutral-400 md:inline">
          {props.template.name}
        </span>
      )}
      {props.session && (
        <span className="hidden truncate text-xs text-neutral-400 lg:inline">
          {props.session.title}
        </span>
      )}
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-neutral-500">
        <AppIcon
          icon={Activity}
          className={`h-3.5 w-3.5 ${props.running ? "animate-pulse text-emerald-600" : ""}`}
        />
        {currentStatus(props)}
      </span>
    </header>
  );
}
