"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../store";
import { MessageView } from "./MessageView";
import { ChatInput } from "./ChatInput";

export function ChatPane() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const bucket = useChatStore((s) =>
    s.currentSessionId ? s.buckets[s.currentSessionId] : undefined,
  );
  const artifacts = useChatStore((s) => s.artifacts);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  // 用户上滚时暂停自动跟随，回到底部恢复
  const [follow, setFollow] = useState(true);
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
  }, [artifacts, bucket?.runId, currentSessionId, messageOrderKey]);
  const firstRenderedIndex = Math.max(0, totalMessages - renderedCount);
  const renderedMessages = bucket?.messages.slice(firstRenderedIndex) ?? [];

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-900">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
        className="flex-1 overflow-y-auto"
      >
        {!currentSessionId || (bucket?.messages.length ?? 0) === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            {currentSessionId ? "发送一条消息开始对话" : "新建一个会话开始"}
          </div>
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
      <ChatInput />
    </div>
  );
}
