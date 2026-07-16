"use client";

import { useEffect, useState } from "react";
import {
  BrainCircuit,
  Check,
  ChevronRight,
  Monitor,
  Moon,
  Network,
  Palette,
  Settings,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { McpSettingsCard } from "./McpSettingsCard";
import { ModelSettings } from "./ModelSettings";
import { useThemePreference, type ThemePreference } from "./theme";

type SettingsPage = "general" | "models" | "mcp" | "appearance";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  userName: string;
}

const pages: Array<{ id: SettingsPage; label: string; icon: LucideIcon }> = [
  { id: "general", label: "常规", icon: Settings },
  { id: "models", label: "模型", icon: BrainCircuit },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "mcp", label: "MCP", icon: Network },
];

const themeOptions: Array<{
  id: ThemePreference;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { id: "system", label: "自动", description: "跟随系统设置", icon: Monitor },
  { id: "light", label: "浅色", description: "始终使用浅色主题", icon: Sun },
  { id: "dark", label: "深色", description: "始终使用深色主题", icon: Moon },
];

export function SettingsDialog({ open, onClose, userName }: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>("general");
  const { theme, setTheme } = useThemePreference();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex h-[min(560px,calc(100vh-48px))] w-full max-w-3xl overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <aside className="w-52 shrink-0 border-r border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-950/50">
          <h2 className="px-3 pb-4 pt-2 text-lg font-semibold">设置</h2>
          <nav className="space-y-1" aria-label="设置分类">
            {pages.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  page === id
                    ? "bg-neutral-200 font-medium dark:bg-neutral-800"
                    : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} />
                {label}
                {page === id && <ChevronRight className="ml-auto h-3.5 w-3.5" />}
              </button>
            ))}
          </nav>
        </aside>

        <main className="relative min-w-0 flex-1 overflow-y-auto p-8">
          <button
            onClick={onClose}
            title="关闭设置"
            className="absolute right-4 top-4 rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
          {page === "general" && <GeneralSettings userName={userName} />}
          {page === "models" && <ModelSettings />}
          {page === "mcp" && <McpSettings />}
          {page === "appearance" && (
            <AppearanceSettings theme={theme} onThemeChange={setTheme} />
          )}
        </main>
      </div>
    </div>
  );
}

function GeneralSettings({ userName }: { userName: string }) {
  return (
    <section>
      <h3 className="text-xl font-semibold">常规</h3>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">管理应用的常规设置。</p>
      <div className="mt-8 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">当前用户</p>
        <p className="mt-2 font-medium">{userName}</p>
      </div>
    </section>
  );
}

function McpSettings() {
  return (
    <section>
      <h3 className="text-xl font-semibold">MCP</h3>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        管理远程 Hermes 可通过 bridge 转发访问的本机 MCP server。
      </p>
      <div className="mt-8">
        <McpSettingsCard />
      </div>
    </section>
  );
}

function AppearanceSettings({
  theme,
  onThemeChange,
}: {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  return (
    <section>
      <h3 className="text-xl font-semibold">外观</h3>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">选择 SilverRetort 的显示主题。</p>
      <div className="mt-8">
        <p className="mb-3 text-sm font-medium">主题</p>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map(({ id, label, description, icon: Icon }) => {
            const selected = theme === id;
            return (
              <button
                key={id}
                onClick={() => onThemeChange(id)}
                aria-pressed={selected}
                className={`relative rounded-xl border p-4 text-left transition-colors ${
                  selected
                    ? "border-neutral-900 bg-neutral-50 ring-1 ring-neutral-900 dark:border-neutral-100 dark:bg-neutral-800 dark:ring-neutral-100"
                    : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
                }`}
              >
                <Icon className="h-6 w-6" strokeWidth={1.6} />
                <span className="mt-4 block text-sm font-medium">{label}</span>
                <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">{description}</span>
                {selected && (
                  <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900">
                    <Check className="h-3 w-3" strokeWidth={2.5} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
