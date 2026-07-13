"use client";

import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { subscribeEvents } from "silverretort-protocol";
import { listRenderTypes } from "../registry";
import { useChatStore } from "../store";
import { ArtifactPanel } from "./ArtifactPanel";
import { ChatPane } from "./ChatPane";
import { AppIcon } from "./icons";
import { SessionSidebar } from "./SessionSidebar";

const separatorClass =
  "w-1 bg-neutral-200 transition-colors hover:bg-neutral-400 data-[resize-handle-state=drag]:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600";

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
    // 甯搁┗浜嬩欢閫氶亾锛氭墍鏈?run 浜嬩欢 + MCP UI 鍛戒护閮戒粠杩欓噷杩涙潵
    const stop = subscribeEvents(store.client.eventsUrl(), {
      onEvent: (event) => useChatStore.getState().applyEvent(event),
      onConnected: () => {
        void useChatStore.getState().resyncCurrent();
        // 涓婃姤娓叉煋鍣ㄦ敞鍐岃〃锛屼緵 agent 缁?MCP 鏌ヨ ui_list_render_types
        void fetch("/api/render-types", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ types: listRenderTypes() }),
        });
      },
    });
    return () => {
      window.removeEventListener("silverretort:model-settings-changed", refreshModelSettings);
      stop();
    };
  }, []);

  return (
    <div className="flex h-screen w-screen text-neutral-900 dark:text-neutral-100">
      <button
        title={sidebarOpen ? "鏀惰捣浼氳瘽鍒楄〃" : "灞曞紑浼氳瘽鍒楄〃"}
        onClick={() => setSidebarOpen((v) => !v)}
        className="absolute left-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 bg-white text-neutral-600 transition-colors hover:text-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
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
              className="dark:bg-neutral-900"
              id="sidebar"
              order={1}
              defaultSize={18}
              minSize={12}
              maxSize={32}
            >
              <div className="h-full pt-10">
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
