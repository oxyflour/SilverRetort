"use client";

import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { subscribeEvents } from "silverretort-protocol";
import { listRenderDefinitions } from "../registry";
import type { ArtifactModuleReport } from "../registry";
import { registerBuiltinRenderers } from "../renderers/builtins";
import { useChatStore } from "../store";
import { ArtifactPanel } from "./ArtifactPanel";
import { ChatPane } from "./ChatPane";
import { AppIcon } from "./icons";
import { SessionSidebar } from "./SessionSidebar";

registerBuiltinRenderers();

const separatorClass =
  "w-1 bg-neutral-200 transition-colors hover:bg-neutral-400 data-[resize-handle-state=drag]:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600";

async function loadArtifactModules(): Promise<ArtifactModuleReport[]> {
  try {
    const response = await fetch("/artifact-modules/manifest.json");
    if (!response.ok) return [];
    const manifest = (await response.json()) as {
      modules?: Array<Omit<ArtifactModuleReport, "importUrl"> & { importPath: string }>;
    };
    return (manifest.modules ?? []).map(({ importPath, ...module }) => ({
      ...module,
      importUrl: new URL(importPath, window.location.origin).href,
    }));
  } catch {
    return [];
  }
}

export function ChatApp() {
  const panelOpen = useChatStore((state) => {
    const sessionId = state.currentSessionId;
    if (!sessionId) {
      return false;
    }
    const workspace = state.artifactWorkspaces[sessionId];
    return Boolean(workspace?.open && workspace.tabIds.length > 0);
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const store = useChatStore.getState();
    void store.refreshSessions();
    const refreshModelSettings = () => {
      const current = useChatStore.getState();
      void current.refreshHermesControls();
      if (current.currentSessionId) {
        void current.refreshSessionModel(current.currentSessionId);
      }
    };
    window.addEventListener("silverretort:model-settings-changed", refreshModelSettings);
    const refreshSwitchProfiles = () => {
      void useChatStore.getState().refreshSessions();
    };
    window.addEventListener("silverretort:switch-profiles-changed", refreshSwitchProfiles);
    // Subscribe to run events and MCP UI commands through one long-lived event stream.
    const stop = subscribeEvents(store.client.eventsUrl(), {
      onEvent: (event) => useChatStore.getState().applyEvent(event),
      onConnected: () => {
        void useChatStore.getState().resyncCurrent();
        // Report registered renderers so the agent can discover them via MCP.
        void loadArtifactModules().then((artifactModules) =>
          fetch("/api/render-types", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              renderers: listRenderDefinitions(artifactModules),
            }),
          }),
        );
      },
    });
    return () => {
      window.removeEventListener("silverretort:model-settings-changed", refreshModelSettings);
      window.removeEventListener("silverretort:switch-profiles-changed", refreshSwitchProfiles);
      stop();
    };
  }, []);

  return (
    <div className="flex h-screen w-screen text-neutral-900 dark:text-neutral-100">
      <button
        title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        onClick={() => setSidebarOpen((v) => !v)}
        className="absolute left-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <AppIcon
          icon={sidebarOpen ? PanelLeftClose : PanelLeftOpen}
          className="h-4 w-4"
        />
      </button>
      <PanelGroup direction="horizontal" className="h-full w-full">
        {sidebarOpen && (
          <>
            <Panel
              className="dark:bg-neutral-900 bg-neutral-50"
              id="sidebar"
              order={1}
              defaultSize={18}
              minSize={12}
              maxSize={32}
            >
              <div className="h-full">
                <SessionSidebar />
              </div>
            </Panel>
            <PanelResizeHandle className={separatorClass} />
          </>
        )}
        <Panel id="chat" order={2} minSize={30}>
          <ChatPane />
        </Panel>
        {panelOpen && (
          <>
            <PanelResizeHandle className={separatorClass} />
            <Panel id="artifact" order={3} defaultSize={40} minSize={20}>
              <ArtifactPanel />
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}
