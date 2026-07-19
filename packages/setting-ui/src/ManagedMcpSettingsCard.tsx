"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  LoaderCircle,
  Play,
  Power,
  RefreshCw,
  ServerCog,
  Square,
  Trash2,
} from "lucide-react";

interface ManagedMcpServer {
  id: string;
  serverName: string;
  name: string;
  description: string;
  version: string;
  installedVersion: string;
  installed: boolean;
  enabled: boolean;
  autoStart: boolean;
  running: boolean;
  port: number;
  url: string;
  config: Record<string, unknown>;
  configFields: ConfigField[];
  error: string;
  logPath: string;
}

interface ConfigField {
  key: string;
  label: string;
  type: "boolean" | "string" | "stringList";
  placeholder?: string;
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.detail === "string" ? payload.detail : `${path} 请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

function textToRoots(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function configValueToText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join("\n") : String(value || "");
}

function patchConfigValue(config: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  return { ...config, [key]: value };
}

export function ManagedMcpSettingsCard() {
  const [servers, setServers] = useState<ManagedMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>("");
  const [error, setError] = useState<string>("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await requestJson<{ servers: ManagedMcpServer[] }>("/api/hermes/managed-mcp");
      setServers(payload.servers || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const runAction = async (id: string, action: "install" | "start" | "stop" | "delete", body?: unknown) => {
    setBusyId(`${id}:${action}`);
    setError("");
    try {
      const method = action === "delete" ? "DELETE" : "POST";
      const suffix = action === "delete" ? "" : `/${action}`;
      await requestJson(`/api/hermes/managed-mcp/${id}${suffix}`, {
        method,
        body: method === "DELETE" ? undefined : JSON.stringify(body || {}),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  };

  const patchServer = async (id: string, patch: unknown) => {
    setBusyId(`${id}:patch`);
    setError("");
    try {
      await requestJson(`/api/hermes/managed-mcp/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  };

  return (
    <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
            <ServerCog className="h-5 w-5" strokeWidth={1.7} />
          </span>
          <div>
            <p className="text-sm font-medium">受管 MCP</p>
            <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
              SilverRetort 可自动安装并托管这些本机 MCP adapter。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-neutral-300 p-2 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
          title="刷新"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-neutral-500">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          正在读取受管 MCP...
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {servers.map((server) => (
            <ManagedMcpRow
              key={server.id}
              server={server}
              busy={busyId.startsWith(`${server.id}:`)}
              onAction={(action) => void runAction(server.id, action)}
              onPatch={(patch) => void patchServer(server.id, patch)}
            />
          ))}
        </div>
      )}

      {error && <p className="mt-4 text-xs text-red-500">{error}</p>}
    </div>
  );
}

function ManagedMcpRow({
  server,
  busy,
  onAction,
  onPatch,
}: {
  server: ManagedMcpServer;
  busy: boolean;
  onAction: (action: "install" | "start" | "stop" | "delete") => void;
  onPatch: (patch: unknown) => void;
}) {
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>(server.config || {});

  useEffect(() => {
    setDraftConfig(server.config || {});
  }, [server.config]);

  const saveConfig = () => {
    onPatch({ config: draftConfig });
  };

  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{server.name}</p>
            {server.running ? (
              <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                运行中
              </span>
            ) : (
              <span className="text-xs text-neutral-500">未运行</span>
            )}
          </div>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {server.serverName} · {server.installed ? `已安装 ${server.installedVersion}` : "未安装"} · {server.url}
          </p>
        </div>

        {!server.installed ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction("install")}
            className="flex items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
            安装并启动
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(server.running ? "stop" : "start")}
              title={server.running ? "停止" : "启动"}
              className="rounded-lg border border-neutral-300 p-2 text-neutral-700 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-200"
            >
              {busy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : server.running ? (
                <Square className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("delete")}
              title="卸载"
              className="rounded-lg border border-neutral-300 p-2 text-neutral-500 hover:text-red-500 disabled:opacity-40 dark:border-neutral-700"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {server.installed && (
        <div className="mt-4 grid gap-3">
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={(event) => onPatch({ enabled: event.target.checked })}
              />
              启用
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={server.autoStart}
                onChange={(event) => onPatch({ autoStart: event.target.checked })}
              />
              自动启动
            </label>
            {server.configFields
              .filter((field) => field.type === "boolean")
              .map((field) => (
                <label key={field.key} className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={Boolean(draftConfig[field.key])}
                    onChange={(event) =>
                      setDraftConfig((current) => patchConfigValue(current, field.key, event.target.checked))
                    }
                  />
                  {field.label}
                </label>
              ))}
          </div>

          {server.configFields
            .filter((field) => field.type !== "boolean")
            .map((field) => (
              <label key={field.key} className="text-xs text-neutral-500 dark:text-neutral-400">
                {field.label}
                {field.type === "stringList" ? (
                  <textarea
                    value={configValueToText(draftConfig[field.key])}
                    onChange={(event) =>
                      setDraftConfig((current) => patchConfigValue(current, field.key, textToRoots(event.target.value)))
                    }
                    rows={3}
                    placeholder={field.placeholder || ""}
                    className="mt-1.5 w-full resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                ) : (
                  <input
                    value={configValueToText(draftConfig[field.key])}
                    onChange={(event) =>
                      setDraftConfig((current) => patchConfigValue(current, field.key, event.target.value))
                    }
                    placeholder={field.placeholder || ""}
                    className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                  />
                )}
              </label>
            ))}
          <div className="flex items-center justify-between gap-3">
            {server.error && <p className="text-xs text-red-500">{server.error}</p>}
            <button
              type="button"
              disabled={busy}
              onClick={saveConfig}
              className="ml-auto rounded-lg border border-neutral-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-neutral-700"
            >
              保存配置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
