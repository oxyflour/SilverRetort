import { ChatEvent, ChatEventSchema } from "./types";

/**
 * 解析 text/event-stream 字节流，逐条产出 data 字段文本。
 * 只处理 data:/多行 data: 拼接，忽略 event:/id:/retry: 与注释行。
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) return null;
    const data = dataLines.join("\n");
    dataLines = [];
    return data;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line === "") {
          const data = flush();
          if (data !== null) yield data;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    const data = flush();
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

export interface EventStreamOptions {
  /** 事件回调；解析失败的帧会被跳过并走 onParseError */
  onEvent: (event: ChatEvent) => void;
  onParseError?: (raw: string, error: unknown) => void;
  /** 连接断开后的重连初始等待毫秒数，默认 1000，指数退避到 15s */
  retryBaseMs?: number;
  signal?: AbortSignal;
  /** 每次(重)连成功时回调，前端借此重拉数据补断线缺口 */
  onConnected?: () => void;
}

/**
 * 订阅常驻事件通道（GET /api/events），带自动重连。
 * 返回 stop 函数；也可通过 options.signal 取消。
 */
export function subscribeEvents(url: string, options: EventStreamOptions): () => void {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const retryBase = options.retryBaseMs ?? 1000;

  (async () => {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const res = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`event stream HTTP ${res.status}`);
        }
        attempt = 0;
        options.onConnected?.();
        for await (const data of parseSseStream(res.body)) {
          try {
            options.onEvent(ChatEventSchema.parse(JSON.parse(data)));
          } catch (error) {
            options.onParseError?.(data, error);
          }
        }
      } catch {
        // 网络错误或流中断：走重连
      }
      if (signal.aborted) break;
      const wait = Math.min(retryBase * 2 ** attempt, 15000);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  })();

  return () => controller.abort();
}
