import { ArrowUpRight, Sparkles } from "lucide-react";
import type { WorkspaceTemplate } from "silverretort-protocol";
import { AppIcon } from "./icons";

interface EmptySessionGuideProps {
  hasSession: boolean;
  template?: WorkspaceTemplate;
  onSelectSuggestion: (prompt: string) => void;
}

export function EmptySessionGuide({
  hasSession,
  template,
  onSelectSuggestion,
}: EmptySessionGuideProps) {
  if (!hasSession) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        新建一个会话开始
      </div>
    );
  }

  if (!template) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        发送一条消息开始对话
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-6 py-10">
      <div className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
        <AppIcon icon={Sparkles} className="h-4 w-4" />
        {template.name}
      </div>
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
        {template.emptyState.title}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500 dark:text-neutral-400">
        {template.emptyState.description}
      </p>
      <div className="mt-6 divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {template.emptyState.suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            onClick={() => onSelectSuggestion(suggestion.prompt)}
            className="group flex w-full items-center gap-3 py-3 text-left text-sm text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white"
          >
            <span className="min-w-0 flex-1">{suggestion.label}</span>
            <AppIcon
              icon={ArrowUpRight}
              className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
