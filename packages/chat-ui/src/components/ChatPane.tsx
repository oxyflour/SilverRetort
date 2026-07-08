"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../store";
import { MessageView } from "./MessageView";
import { ChatInput } from "./ChatInput";

export function ChatPane() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const bucket = useChatStore((s) =>
    s.currentSessionId ? s.buckets[s.currentSessionId] : undefined,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // 用户上滚时暂停自动跟随，回到底部恢复
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [bucket?.messages, follow]);

  useEffect(() => {
    setFollow(true);
  }, [currentSessionId]);

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
          bucket!.messages.map((message) => (
            <MessageView key={message.id} message={message} />
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
