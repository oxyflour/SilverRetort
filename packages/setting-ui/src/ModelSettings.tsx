"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Cloud, Cpu, Eye, HardDrive, LoaderCircle, PencilLine, Trash2 } from "lucide-react";

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

interface SwitchProfile {
  id: string;
  name: string;
  mode: "local" | "remote";
  switchUrl: string;
  hasHermesApiKey: boolean;
}

interface HermesConnection {
  localHermesEnabled: boolean;
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

type HermesSettingsTab = "local" | "remote";

function isCustomProvider(provider: string) {
  return provider.trim().toLowerCase() === "custom";
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function deleteRequest(path: string): Promise<void> {
  const response = await fetch(path, { method: "DELETE" });
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
}

export function ModelSettings() {
  const [models, setModels] = useState<HermesModel[]>([]);
  const [primary, setPrimary] = useState<ModelValue>(emptyModel);
  const [vision, setVision] = useState<ModelValue>(emptyModel);
  const [separateVision, setSeparateVision] = useState(false);
  const [localHermesEnabled, setLocalHermesEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState<HermesSettingsTab>("local");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      const connection = await getJson<HermesConnection>("/api/hermes/connection");
      if (cancelled) return;
      setLocalHermesEnabled(Boolean(connection.localHermesEnabled));
      if (!connection.localHermesEnabled) {
        setActiveTab("remote");
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
      setError("Primary provider and model are required.");
      return;
    }
    if (isCustomProvider(nextPrimary.provider) && !nextPrimary.baseUrl) {
      setError("Primary custom Base URL is required.");
      return;
    }
    if (separateVision && (!nextVision.provider || !nextVision.model)) {
      setError("Vision provider and model are required.");
      return;
    }
    if (
      separateVision &&
      isCustomProvider(nextVision.provider) &&
      !nextVision.baseUrl
    ) {
      setError("Vision custom Base URL is required.");
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

  const tabClass = (tab: HermesSettingsTab) =>
    `inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
      activeTab === tab
        ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100"
        : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
    }`;

  const localHermesPanel = (
    <>
      <ModelCard
        icon={Cpu}
        title="Primary model"
        description="Used for chat, reasoning, and tool calls."
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
              <p className="text-sm font-medium">Vision model</p>
              <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                Used for image understanding when the primary model lacks vision support.
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Use a separate vision model"
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
            Currently follows primary model: {primary.model || "not configured"}
          </p>
        )}
      </div>

      <div className="flex min-h-9 items-center justify-between gap-4 pt-1">
        <div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          {saved && !error && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved.
            </p>
          )}
        </div>
        <button
          disabled={saving}
          onClick={() => void save()}
          className="rounded-lg bg-neutral-900 px-5 py-2 text-sm text-white transition-opacity disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {saving ? "Saving..." : "Save model settings"}
        </button>
      </div>
    </>
  );

  return (
    <section>
      <h3 className="text-xl font-semibold">Models</h3>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {localHermesEnabled
          ? "Configure local Hermes models and remote switchUrl profiles."
          : "Configure remote switchUrl profiles."}
      </p>

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-neutral-500">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading model settings...
        </div>
      ) : localHermesEnabled ? (
        <div className="mt-8 space-y-4">
          <div className="inline-flex rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800">
            <button
              type="button"
              onClick={() => setActiveTab("local")}
              className={tabClass("local")}
            >
              <HardDrive className="h-4 w-4" />
              Local Hermes
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("remote")}
              className={tabClass("remote")}
            >
              <Cloud className="h-4 w-4" />
              Remote Hermes
            </button>
          </div>
          {activeTab === "local" ? localHermesPanel : <SwitchProfilesCard />}
        </div>
      ) : (
        <div className="mt-8">
          {error && <p className="mb-4 text-xs text-red-500">{error}</p>}
          <SwitchProfilesCard />
        </div>
      )}
    </section>
  );
}

function SwitchProfilesCard() {
  const [profiles, setProfiles] = useState<SwitchProfile[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("Remote");
  const [switchUrl, setSwitchUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setProfiles(await getJson<SwitchProfile[]>("/api/switch-profiles"));
  };

  useEffect(() => {
    void load().catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setName("Remote");
    setSwitchUrl("");
    setApiKey("");
  };

  const startEdit = (profile: SwitchProfile) => {
    if (profile.mode !== "remote") return;
    setEditingId(profile.id);
    setName(profile.name);
    setSwitchUrl(profile.switchUrl);
    setApiKey("");
    setError(null);
  };

  const save = async () => {
    const cleanUrl = switchUrl.trim().replace(/\/$/, "");
    if (!cleanUrl) {
      setError("Switch URL is required.");
      return;
    }
    if (!editingId && !apiKey.trim()) {
      setError("API key is required for a new switchUrl.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await patchJson<SwitchProfile>(`/api/switch-profiles/${editingId}`, {
          name: name.trim() || "Remote",
          switchUrl: cleanUrl,
          ...(apiKey.trim() ? { hermesApiKey: apiKey.trim() } : {}),
        });
      } else {
        await postJson<SwitchProfile>("/api/switch-profiles", {
          name: name.trim() || "Remote",
          switchUrl: cleanUrl,
          hermesApiKey: apiKey.trim(),
        });
      }
      resetForm();
      await load();
      window.dispatchEvent(new Event("silverretort:switch-profiles-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (profile: SwitchProfile) => {
    if (profile.mode !== "remote") return;
    setSaving(true);
    setError(null);
    try {
      await deleteRequest(`/api/switch-profiles/${profile.id}`);
      await load();
      if (editingId === profile.id) resetForm();
      window.dispatchEvent(new Event("silverretort:switch-profiles-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
          <Cloud className="h-5 w-5" strokeWidth={1.7} />
        </span>
        <div>
          <p className="text-sm font-medium">switchUrl</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            Configure remote switchUrl profiles used by workspace creation.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="flex items-center gap-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800/70"
          >
            {profile.mode === "local" ? (
              <HardDrive className="h-4 w-4 text-neutral-500" />
            ) : (
              <Cloud className="h-4 w-4 text-neutral-500" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{profile.name}</p>
              <p className="truncate text-xs text-neutral-500">
                {profile.mode === "local"
                  ? "Local Hermes"
                  : `${profile.switchUrl}${profile.hasHermesApiKey ? " - Key configured" : " - Key missing"}`}
              </p>
            </div>
            {profile.mode === "remote" && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title="Edit switchUrl"
                  onClick={() => startEdit(profile)}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                >
                  <PencilLine className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="Delete switchUrl"
                  onClick={() => void remove(profile)}
                  className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-red-600 dark:hover:bg-neutral-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>

    <div className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{editingId ? "Edit switchUrl" : "Add switchUrl"}</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            {editingId ? "Update the selected remote Hermes profile." : "Create a remote Hermes profile for new workspaces."}
          </p>
        </div>
        {editingId && (
          <button
            type="button"
            onClick={resetForm}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
          >
            Cancel edit
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3">
        <div className="grid grid-cols-[minmax(120px,0.7fr)_minmax(180px,1.3fr)] gap-3">
          <label className="text-xs text-neutral-500 dark:text-neutral-400">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </label>
          <label className="text-xs text-neutral-500 dark:text-neutral-400">
            switchUrl
            <input
              type="url"
              value={switchUrl}
              onChange={(event) => setSwitchUrl(event.target.value)}
              placeholder="https://switch.example/endpoint/alice"
              className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </label>
        </div>
        <label className="text-xs text-neutral-500 dark:text-neutral-400">
          API key
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editingId ? "Leave blank to keep the existing key" : "Required for remote switchUrl profiles"}
            className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>
      </div>

      <div className="mt-4 flex min-h-8 items-center justify-between gap-3">
        {error ? <p className="text-xs text-red-500">{error}</p> : <span />}
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white transition-opacity disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {saving ? "Saving..." : editingId ? "Save switchUrl" : "Add switchUrl"}
        </button>
      </div>
    </div>
    </>
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
        Provider
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
        Model ID
        <input
          list={`${idPrefix}-models`}
          value={value.model}
          onChange={(event) => {
            const model = event.target.value;
            const match = models.find((item) => item.model === model);
            onChange({ model, ...(match ? { provider: match.provider } : {}) });
          }}
          placeholder="e.g. gpt-4.1"
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
            API Key (optional)
            <input
              type="password"
              autoComplete="new-password"
              value={value.apiKey}
              onChange={(event) => onChange({ apiKey: event.target.value })}
              placeholder={
                value.hasApiKey
                  ? "Leave blank to keep the existing key when Base URL is unchanged"
                  : "Can be blank for local unauthenticated services"
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
