import { Copy, PencilLine } from "lucide-react";
import type { Message } from "silverretort-protocol";
import { AppIcon } from "./icons";

interface MessageHeaderProps {
  message: Message;
  running: boolean;
  saving: boolean;
  editing: boolean;
  canRestart: boolean;
  onCopy: () => void;
  onRestart: () => void;
}

export function MessageHeader({
  message,
  running,
  saving,
  editing,
  canRestart,
  onCopy,
  onRestart,
}: MessageHeaderProps) {
  const isUser = message.role === "user";
  const defaultHeader = (
    <>
      <span>{isUser ? "User" : "Assistant"}</span>
      {message.status === "streaming" && (
        <span className="animate-pulse text-emerald-600">Streaming</span>
      )}
      {message.status === "error" && <span className="text-red-500">Error</span>}
      {message.status === "stopped" && (
        <span className="text-neutral-400">Stopped</span>
      )}
      {isUser && (
        <span className="ml-auto flex shrink-0 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
          <button
            type="button"
            title="Copy message"
            onClick={onCopy}
            className="rounded p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            <AppIcon icon={Copy} className="h-4 w-4" />
          </button>
          {canRestart && (
            <button
              type="button"
              title="Edit and restart"
              onClick={onRestart}
              disabled={running || saving || editing}
              className="rounded p-1 text-neutral-500 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-neutral-100"
            >
              <AppIcon icon={PencilLine} className="h-4 w-4" />
            </button>
          )}
        </span>
      )}
    </>
  );

  return (
    <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-neutral-500">
      {defaultHeader}
    </div>
  );
}
