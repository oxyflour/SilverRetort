"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../store";
import { MessageView } from "./MessageView";
import { ChatInput } from "./ChatInput";
import { GoalStatusBar } from "./GoalStatusBar";
import { ChatPaneToolbarSlot, EmptySessionSlot } from "../templateSlots";

export function ChatPane() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const bucket = useChatStore((s) =>
    s.currentSessionId ? s.buckets[s.currentSessionId] : undefined,
  );
  const artifacts = useChatStore((s) => s.artifacts);
  const currentWorkspace = useChatStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.currentWorkspaceId),
  );
  const currentTemplate = useChatStore((s) =>
    s.workspaceTemplates.find(
      (template) => template.id === currentWorkspace?.templateId,
    ),
  );
  const currentSession = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.currentSessionId),
  );
  const sendMessage = useChatStore((s) => s.sendMessage);
  const refreshHermesRuntime = useChatStore((s) => s.refreshHermesRuntime);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  // 用户上滚时暂停自动跟随，回到底部恢复
  const [follow, setFollow] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [renderWindow, setRenderWindow] = useState({
    sessionId: "",
    count: 8,
  });

  useEffect(() => {
    if (follow && scrollRef.current) {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        scrollFrameRef.current = null;
      });
    }
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [bucket?.messages, follow, renderWindow.count]);

  useEffect(() => {
    setFollow(true);
  }, [currentSessionId]);

  useEffect(() => {
    if (currentSessionId) {
      void refreshHermesRuntime(currentSessionId);
    }
  }, [currentSessionId, refreshHermesRuntime]);

  const renderedCount =
    renderWindow.sessionId === currentSessionId ? renderWindow.count : 8;
  const totalMessages = bucket?.messages.length ?? 0;

  useEffect(() => {
    if (!currentSessionId || renderedCount >= totalMessages) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setRenderWindow({
        sessionId: currentSessionId,
        count: Math.min(totalMessages, renderedCount + 8),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentSessionId, renderedCount, totalMessages]);

  const messageOrderKey = bucket?.messages
    .map((message) => `${message.id}:${message.createdAt}`)
    .join("|");
  const messageContext = useMemo(() => {
    const sessionArtifacts = Object.values(artifacts)
      .filter((artifact) => artifact.sessionId === currentSessionId)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
    return {
      artifacts,
      running: bucket?.runId != null,
      sessionMessages: bucket?.messages ?? [],
      sessionArtifactIds: sessionArtifacts.map((artifact) => artifact.id),
      artifactCreatedAtById: Object.fromEntries(
        sessionArtifacts.map((artifact) => [artifact.id, artifact.createdAt]),
      ),
    };
  }, [
    artifacts,
    bucket?.runId,
    currentSessionId,
    messageOrderKey,
  ]);
  const firstRenderedIndex = Math.max(0, totalMessages - renderedCount);
  const renderedMessages = bucket?.messages.slice(firstRenderedIndex) ?? [];
  const sessionArtifacts = Object.values(artifacts).filter(
    (artifact) => artifact.sessionId === currentSessionId,
  );
  const selectPrompt = (prompt: string) => {
    if (!currentSessionId) return;
    setDrafts((current) => ({ ...current, [currentSessionId]: prompt }));
  };
  const sendTemplateMessage = async (text: string) => {
    const prompt = text.trim();
    if (!currentSessionId || bucket?.runId != null || !prompt) return;
    setDrafts((current) => ({ ...current, [currentSessionId]: "" }));
    await sendMessage(prompt);
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
      {currentWorkspace && (
        <ChatPaneToolbarSlot
          workspace={currentWorkspace}
          template={currentTemplate}
          session={currentSession ?? null}
          messages={bucket?.messages ?? []}
          artifacts={sessionArtifacts}
          running={bucket?.runId != null}
          setDraft={selectPrompt}
          sendMessage={sendTemplateMessage}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
          }}
          className="h-full overflow-y-auto"
        >
          {!currentSessionId || (bucket?.messages.length ?? 0) === 0 ? (
            <EmptySessionSlot
              hasSession={Boolean(currentSessionId)}
              workspace={currentWorkspace}
              template={currentTemplate}
              session={currentSession ?? null}
              setDraft={selectPrompt}
            />
          ) : (
            renderedMessages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                context={messageContext}
              />
            ))
          )}
          {bucket?.error && (
            <div className="mx-auto max-w-3xl px-4 py-2 text-sm text-red-500">
              {bucket.error}
            </div>
          )}
        </div>
      </div>
      <GoalStatusBar />
      <ChatInput
        text={currentSessionId ? drafts[currentSessionId] ?? "" : ""}
        onTextChange={(text) => {
          if (!currentSessionId) return;
          setDrafts((current) => ({ ...current, [currentSessionId]: text }));
        }}
      />
    </div>
  );
}
