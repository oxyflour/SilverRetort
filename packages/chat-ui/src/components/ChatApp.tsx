"use client";

import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { subscribeEvents } from "silverretort-protocol";
import { useChatStore } from "../store";
import { listRenderTypes } from "../registry";
import { registerBuiltinRenderers } from "../renderers/builtins";
import { SessionSidebar } from "./SessionSidebar";
import { ChatPane } from "./ChatPane";
import { ArtifactPanel } from "./ArtifactPanel";

registerBuiltinRenderers();

const separatorClass =
  "w-1 bg-neutral-200 transition-colors hover:bg-neutral-400 data-[resize-handle-state=drag]:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600";

export function ChatApp() {
  const panelOpen = useChatStore((s) => s.panel.open);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const store = useChatStore.getState();
    void store.refreshSessions();
    // 常驻事件通道：所有 run 事件 + MCP UI 命令都从这里进来
    const stop = subscribeEvents(store.client.eventsUrl(), {
      onEvent: (event) => useChatStore.getState().applyEvent(event),
      onConnected: () => {
        void useChatStore.getState().resyncCurrent();
        // 上报渲染器注册表，供 agent 经 MCP 查询 ui_list_render_types
        void fetch("/api/render-types", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ types: listRenderTypes() }),
        });
      },
    });
    return stop;
  }, []);

  return (
    <div className="flex h-screen w-screen text-neutral-900 dark:text-neutral-100">
      <button
        title={sidebarOpen ? "收起会话列表" : "展开会话列表"}
        onClick={() => setSidebarOpen((v) => !v)}
        className="absolute left-2 top-2 z-10 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-900"
      >
        ☰
      </button>
      <PanelGroup direction="horizontal" className="h-full w-full">
        {sidebarOpen && (
          <>
            <Panel id="sidebar" order={1} defaultSize={18} minSize={12} maxSize={32}>
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
