"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, Network, Trash2 } from "lucide-react";
import { ManagedMcpSettingsCard } from "./ManagedMcpSettingsCard";

interface McpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}

interface McpServerForm {
  name: string;
  url: string;
  headersText: string;
  enabled: boolean;
}

const emptyServer: McpServerForm = {
  name: "",
  url: "http://127.0.0.1:9901/mcp/",
  headersText: "{}",
  enabled: true,
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} 请求失败（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} 保存失败（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}

function serverToForm(server: McpServer): McpServerForm {
  return {
    name: server.name,
    url: server.url,
    headersText: JSON.stringify(server.headers || {}, null, 2),
    enabled: server.enabled,
  };
}

function parseHeaders(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Headers 必须是 JSON object。");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );
}

function validateServer(server: McpServerForm, index: number) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(server.name.trim())) {
    throw new Error(`第 ${index + 1} 个 MCP server 名称只能包含字母、数字、_ 和 -。`);
  }
  const url = new URL(server.url.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`MCP server ${server.name} 只能使用 http 或 https。`);
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`MCP server ${server.name} 必须指向本机 loopback。`);
  }
}

export function McpSettingsCard() {
  const [servers, setServers] = useState<McpServerForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getJson<{ servers: McpServer[] }>("/api/hermes/mcp-servers")
      .then((payload) => {
        if (!cancelled) setServers((payload.servers || []).map(serverToForm));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addServer = () => {
    setServers((current) => [...current, { ...emptyServer }]);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const names = new Set<string>();
      const payload = servers.map((server, index) => {
        validateServer(server, index);
        const name = server.name.trim();
        if (names.has(name)) throw new Error(`MCP server 名称重复：${name}`);
        names.add(name);
        return {
          name,
          url: server.url.trim(),
          headers: parseHeaders(server.headersText),
          enabled: server.enabled,
        };
      });
      const response = await putJson<{ servers: McpServer[] }>("/api/hermes/mcp-servers", {
        servers: payload,
      });
      setServers((response.servers || []).map(serverToForm));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <ManagedMcpSettingsCard />
      <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
            <Network className="h-5 w-5" strokeWidth={1.7} />
          </span>
          <div>
            <p className="text-sm font-medium">本机 MCP 转发</p>
            <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
              远程 Hermes 可通过 bridge 访问这些本机 HTTP MCP server。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={addServer}
          className="shrink-0 whitespace-nowrap rounded-lg border border-neutral-300 px-5 py-2 text-sm dark:border-neutral-700"
        >
          添加
        </button>
      </div>

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-neutral-500">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          正在读取 MCP 配置...
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {servers.length === 0 && (
            <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400">
              尚未配置本机 MCP server。
            </p>
          )}
          {servers.map((server, index) => (
            <McpServerRow
              key={index}
              value={server}
              onChange={(patch) => {
                setServers((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, ...patch } : item,
                  ),
                );
                setSaved(false);
              }}
              onRemove={() => {
                setServers((current) => current.filter((_, itemIndex) => itemIndex !== index));
                setSaved(false);
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          {saved && !error && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              MCP 配置已保存并通知 bridge。
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => void save()}
          className="rounded-lg bg-neutral-900 px-5 py-2 text-sm text-white transition-opacity disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {saving ? "保存中..." : "保存 MCP"}
        </button>
      </div>
    </div>
    </div>
  );
}

function McpServerRow({
  value,
  onChange,
  onRemove,
}: {
  value: McpServerForm;
  onChange: (patch: Partial<McpServerForm>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          启用
        </label>
        <button
          type="button"
          onClick={onRemove}
          title="删除 MCP server"
          className="ml-auto rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(120px,0.7fr)_minmax(180px,1.3fr)] gap-3">
        <label className="text-xs text-neutral-500 dark:text-neutral-400">
          名称
          <input
            value={value.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="filesystem"
            className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>
        <label className="text-xs text-neutral-500 dark:text-neutral-400">
          URL
          <input
            type="url"
            value={value.url}
            onChange={(event) => onChange({ url: event.target.value })}
            placeholder="http://127.0.0.1:9901/mcp/"
            className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>
        <label className="col-span-2 text-xs text-neutral-500 dark:text-neutral-400">
          Headers JSON
          <textarea
            value={value.headersText}
            onChange={(event) => onChange({ headersText: event.target.value })}
            rows={3}
            spellCheck={false}
            className="mt-1.5 w-full resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>
      </div>
    </div>
  );
}
