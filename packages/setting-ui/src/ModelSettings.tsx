"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Cpu, Eye, LoaderCircle } from "lucide-react";

interface HermesModel {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  available: boolean;
}

interface ModelValue {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
}

interface HermesConnection {
  packaged: boolean;
  mode: "local" | "remote";
  hermesUrl: string;
  hasHermesApiKey: boolean;
  restartRequired?: boolean;
}

interface ModelResponse {
  provider: string;
  model: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  inherited?: boolean;
}

const emptyModel: ModelValue = {
  provider: "",
  model: "",
  baseUrl: "",
  apiKey: "",
  hasApiKey: false,
};

function isCustomProvider(provider: string) {
  return provider.trim().toLowerCase() === "custom";
}

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

export function ModelSettings() {
  const [models, setModels] = useState<HermesModel[]>([]);
  const [connection, setConnection] = useState<HermesConnection | null>(null);
  const [connectionMode, setConnectionMode] = useState<"local" | "remote">("local");
  const [hermesUrl, setHermesUrl] = useState("");
  const [hermesApiKey, setHermesApiKey] = useState("");
  const [primary, setPrimary] = useState<ModelValue>(emptyModel);
  const [vision, setVision] = useState<ModelValue>(emptyModel);
  const [separateVision, setSeparateVision] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      const connectionSettings = await getJson<HermesConnection>("/api/hermes/connection");
      if (cancelled) return;
      setConnection(connectionSettings);
      setConnectionMode(connectionSettings.mode);
      setHermesUrl(connectionSettings.hermesUrl || "");
      setHermesApiKey("");

      if (connectionSettings.packaged || connectionSettings.mode === "remote") {
        setModels([]);
        setPrimary(emptyModel);
        setVision(emptyModel);
        setSeparateVision(false);
        return;
      }

      const [catalog, defaultModel, visionModel] = await Promise.all([
        getJson<{ models?: HermesModel[] }>("/api/hermes/models"),
        getJson<ModelResponse>("/api/hermes/default-model"),
        getJson<ModelResponse>("/api/hermes/vision-model"),
      ]);
      if (cancelled) return;
      const nextPrimary = {
        provider: defaultModel.provider || "custom",
        model: defaultModel.model || "",
        baseUrl: defaultModel.baseUrl || "",
        apiKey: "",
        hasApiKey: Boolean(defaultModel.hasApiKey),
      };
      setModels(Array.isArray(catalog.models) ? catalog.models : []);
      setPrimary(nextPrimary);
      setSeparateVision(!visionModel.inherited);
      setVision(
        visionModel.inherited
          ? nextPrimary
          : {
              provider: visionModel.provider,
              model: visionModel.model,
              baseUrl: visionModel.baseUrl || "",
              apiKey: "",
              hasApiKey: Boolean(visionModel.hasApiKey),
            },
      );
    }

    void load()
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

  const providerSuggestions = useMemo(
    () => Array.from(new Set(models.map((item) => item.provider).filter(Boolean))),
    [models],
  );

  const saveConnection = async () => {
    const nextMode = connection?.packaged ? "remote" : connectionMode;
    const nextUrl = hermesUrl.trim().replace(/\/$/, "");
    const nextKey = hermesApiKey.trim();
    if (nextMode === "remote" && !nextUrl) {
      setError("请填写 Hermes URL。");
      return;
    }
    if (nextMode === "remote" && !nextKey && !connection?.hasHermesApiKey) {
      setError("请填写 Hermes API Key。");
      return;
    }

    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const nextConnection = await putJson<HermesConnection>("/api/hermes/connection", {
        mode: nextMode,
        hermesUrl: nextUrl,
        hermesApiKey: nextKey,
      });
      setConnection(nextConnection);
      setConnectionMode(nextConnection.mode);
      setHermesUrl(nextConnection.hermesUrl || "");
      setHermesApiKey("");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const nextPrimary = {
      provider: primary.provider.trim(),
      model: primary.model.trim(),
      baseUrl: primary.baseUrl.trim().replace(/\/$/, ""),
      apiKey: primary.apiKey.trim(),
      hasApiKey: primary.hasApiKey,
    };
    const nextVision = {
      provider: vision.provider.trim(),
      model: vision.model.trim(),
      baseUrl: vision.baseUrl.trim().replace(/\/$/, ""),
      apiKey: vision.apiKey.trim(),
      hasApiKey: vision.hasApiKey,
    };
    if (!nextPrimary.provider || !nextPrimary.model) {
      setError("请完整填写主模型的提供商和模型 ID。");
      return;
    }
    if (isCustomProvider(nextPrimary.provider) && !nextPrimary.baseUrl) {
      setError("使用 custom 提供商时，请填写主模型的 Base URL。");
      return;
    }
    if (separateVision && (!nextVision.provider || !nextVision.model)) {
      setError("请完整填写视觉模型的提供商和模型 ID。");
      return;
    }
    if (
      separateVision &&
      isCustomProvider(nextVision.provider) &&
      !nextVision.baseUrl
    ) {
      setError("使用 custom 提供商时，请填写视觉模型的 Base URL。");
      return;
    }

    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await putJson("/api/hermes/default-model", modelRequest(nextPrimary));
      await putJson(
        "/api/hermes/vision-model",
        separateVision ? modelRequest(nextVision) : {},
      );
      const savedPrimary = hideApiKey(nextPrimary);
      setPrimary(savedPrimary);
      setVision(separateVision ? hideApiKey(nextVision) : savedPrimary);
      setSaved(true);
      window.dispatchEvent(new Event("silverretort:model-settings-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h3 className="text-xl font-semibold">模型</h3>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        配置 Hermes 连接方式，以及开发模式下的本地模型。
      </p>

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-neutral-500">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          正在读取模型配置…
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {connection && (
            <ConnectionCard
              connection={connection}
              mode={connectionMode}
              hermesUrl={hermesUrl}
              hermesApiKey={hermesApiKey}
              onModeChange={(mode) => { setConnectionMode(mode); setSaved(false); }}
              onUrlChange={(value) => { setHermesUrl(value); setSaved(false); }}
              onApiKeyChange={(value) => { setHermesApiKey(value); setSaved(false); }}
              onSave={() => void saveConnection()}
              saving={saving}
            />
          )}

          {!connection?.packaged && connectionMode === "local" && (
            <>
              <ModelCard
                icon={Cpu}
                title="主模型"
                description="用于日常对话、推理和工具调用。"
                value={primary}
                models={models}
                providers={providerSuggestions}
                onChange={(patch) => {
                  setPrimary((current) => ({ ...current, ...patch }));
                  setSaved(false);
                }}
              />

          <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
            <div className="flex items-start justify-between gap-4">
              <div className="flex gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                  <Eye className="h-5 w-5" strokeWidth={1.7} />
                </span>
                <div>
                  <p className="text-sm font-medium">视觉模型</p>
                  <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                    用于图片理解和不具备视觉能力的主模型的视觉任务。
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="使用独立视觉模型"
                aria-checked={separateVision}
                onClick={() => {
                  const enabled = !separateVision;
                  setSeparateVision(enabled);
                  if (enabled) {
                    setVision({
                      ...primary,
                      apiKey: "",
                      hasApiKey: primary.hasApiKey || Boolean(primary.apiKey),
                    });
                  }
                  setSaved(false);
                }}
                className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 ${
                  separateVision ? "bg-neutral-900 dark:bg-neutral-100" : "bg-neutral-300 dark:bg-neutral-700"
                }`}
              >
                <span
                  className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    separateVision
                      ? "translate-x-6 dark:bg-neutral-900"
                      : "translate-x-1 dark:bg-neutral-200"
                  }`}
                />
              </button>
            </div>

            {separateVision ? (
              <ModelFields
                value={vision}
                models={models}
                providers={providerSuggestions}
                idPrefix="vision"
                onChange={(patch) => {
                  setVision((current) => ({ ...current, ...patch }));
                  setSaved(false);
                }}
              />
            ) : (
              <p className="mt-5 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400">
                当前跟随主模型：{primary.model || "尚未配置"}
              </p>
            )}
          </div>
            </>
          )}

          <div className="flex min-h-9 items-center justify-between gap-4 pt-1">
            <div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              {saved && !error && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />{connection?.restartRequired ? "设置已保存，重启后生效" : "设置已保存"}
                </p>
              )}
            </div>
            <button
              disabled={saving}
              onClick={() => void (connectionMode === "local" && !connection?.packaged ? save() : saveConnection())}
              className="rounded-lg bg-neutral-900 px-5 py-2 text-sm text-white transition-opacity disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ConnectionCard({
  connection,
  mode,
  hermesUrl,
  hermesApiKey,
  onModeChange,
  onUrlChange,
  onApiKeyChange,
  onSave,
  saving,
}: {
  connection: HermesConnection;
  mode: "local" | "remote";
  hermesUrl: string;
  hermesApiKey: string;
  onModeChange: (mode: "local" | "remote") => void;
  onUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const remoteOnly = connection.packaged;
  return (
    <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Hermes 连接</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            {remoteOnly
              ? "打包模式只使用远程 Hermes，请配置 apps/switch 提供的 URL 和 API Key。"
              : "开发模式可以使用本地模型配置，也可以切换到远程 hermesUrl。"}
          </p>
        </div>
        <button
          disabled={saving}
          onClick={onSave}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs transition-opacity disabled:opacity-40 dark:border-neutral-700"
        >
          {saving ? "保存中…" : "保存连接"}
        </button>
      </div>

      {!remoteOnly && (
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg bg-neutral-50 p-1 text-sm dark:bg-neutral-800/70">
          <button
            type="button"
            onClick={() => onModeChange("local")}
            className={`rounded-md px-3 py-2 ${mode === "local" ? "bg-white shadow-sm dark:bg-neutral-900" : "text-neutral-500"}`}
          >
            本地模型
          </button>
          <button
            type="button"
            onClick={() => onModeChange("remote")}
            className={`rounded-md px-3 py-2 ${mode === "remote" ? "bg-white shadow-sm dark:bg-neutral-900" : "text-neutral-500"}`}
          >
            hermesUrl
          </button>
        </div>
      )}

      {(remoteOnly || mode === "remote") && (
        <div className="mt-5 grid gap-3">
          <label className="text-xs text-neutral-500 dark:text-neutral-400">
            hermesUrl
            <input
              type="url"
              value={hermesUrl}
              onChange={(event) => onUrlChange(event.target.value)}
              placeholder="http://localhost:8080/endpoint/<userId>"
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </label>
          <label className="text-xs text-neutral-500 dark:text-neutral-400">
            hermesApiKey
            <input
              type="password"
              autoComplete="new-password"
              value={hermesApiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={connection.hasHermesApiKey ? "留空保持现有密钥" : "请输入 apps/switch 用户配置中的 HERMES_API_KEY"}
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </label>
          <p className="text-xs text-amber-600 dark:text-amber-400">连接方式保存后需要重启应用生效。</p>
        </div>
      )}
    </div>
  );
}

function ModelCard({
  icon: Icon,
  title,
  description,
  value,
  models,
  providers,
  onChange,
}: {
  icon: typeof Cpu;
  title: string;
  description: string;
  value: ModelValue;
  models: HermesModel[];
  providers: string[];
  onChange: (patch: Partial<ModelValue>) => void;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
      <div className="flex gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
          <Icon className="h-5 w-5" strokeWidth={1.7} />
        </span>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">{description}</p>
        </div>
      </div>
      <ModelFields
        value={value}
        models={models}
        providers={providers}
        idPrefix="primary"
        onChange={onChange}
      />
    </div>
  );
}

function ModelFields({
  value,
  models,
  providers,
  idPrefix,
  onChange,
}: {
  value: ModelValue;
  models: HermesModel[];
  providers: string[];
  idPrefix: string;
  onChange: (patch: Partial<ModelValue>) => void;
}) {
  const custom = isCustomProvider(value.provider);
  return (
    <div className="mt-5 grid grid-cols-[minmax(120px,0.7fr)_minmax(180px,1.3fr)] gap-3">
      <label className="text-xs text-neutral-500 dark:text-neutral-400">
        提供商
        <input
          list={`${idPrefix}-providers`}
          value={value.provider}
          onChange={(event) => onChange({ provider: event.target.value })}
          placeholder="custom"
          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <datalist id={`${idPrefix}-providers`}>
          {providers.map((provider) => <option key={provider} value={provider} />)}
        </datalist>
      </label>
      <label className="text-xs text-neutral-500 dark:text-neutral-400">
        模型 ID
        <input
          list={`${idPrefix}-models`}
          value={value.model}
          onChange={(event) => {
            const model = event.target.value;
            const match = models.find((item) => item.model === model);
            onChange({ model, ...(match ? { provider: match.provider } : {}) });
          }}
          placeholder="例如 gpt-4.1"
          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <datalist id={`${idPrefix}-models`}>
          {models.filter((model) => model.available).map((model) => (
            <option key={model.id} value={model.model}>{model.providerLabel || model.provider}</option>
          ))}
        </datalist>
      </label>
      {custom && (
        <>
          <label className="col-span-2 text-xs text-neutral-500 dark:text-neutral-400">
            Base URL
            <input
              type="url"
              value={value.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </label>
          <label className="col-span-2 text-xs text-neutral-500 dark:text-neutral-400">
            API Key（可选）
            <input
              type="password"
              autoComplete="new-password"
              value={value.apiKey}
              onChange={(event) => onChange({ apiKey: event.target.value })}
              placeholder={
                value.hasApiKey
                  ? "Base URL 不变时，留空保持现有密钥"
                  : "本地免鉴权服务可留空"
              }
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </label>
        </>
      )}
    </div>
  );
}

function modelRequest(value: ModelValue) {
  const custom = isCustomProvider(value.provider);
  return {
    provider: value.provider,
    model: value.model,
    ...(custom ? { baseUrl: value.baseUrl } : {}),
    ...(custom && value.apiKey ? { apiKey: value.apiKey } : {}),
  };
}

function hideApiKey(value: ModelValue): ModelValue {
  if (!isCustomProvider(value.provider)) {
    return { ...value, baseUrl: "", apiKey: "", hasApiKey: false };
  }
  return {
    ...value,
    apiKey: "",
    hasApiKey: value.hasApiKey || Boolean(value.apiKey),
  };
}
