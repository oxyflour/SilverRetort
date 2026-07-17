"use client";

interface ToolCallPayloadViewProps {
  value: string | null | undefined;
  emptyText: string;
  maxHeightClassName: string;
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-neutral-400">null</span>;
  }
  if (typeof value === "string") {
    return <span className="break-words text-emerald-700 dark:text-emerald-300">"{value}"</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-blue-700 dark:text-blue-300">{String(value)}</span>;
  }
  return <span className="text-neutral-500">{String(value)}</span>;
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (isPrimitive(value)) {
    return <PrimitiveValue value={value} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-neutral-400">[]</span>;
    }
    return (
      <div className={depth > 0 ? "ml-3 border-l border-neutral-200 pl-2 dark:border-neutral-700" : ""}>
        {value.map((item, index) => (
          <div key={index} className="py-0.5">
            <span className="mr-2 text-neutral-400">[{index}]</span>
            {isPrimitive(item) ? (
              <JsonValue value={item} depth={depth + 1} />
            ) : (
              <div className="mt-0.5">
                <JsonValue value={item} depth={depth + 1} />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="text-neutral-400">{"{}"}</span>;
  }

  return (
    <div className={depth > 0 ? "ml-3 border-l border-neutral-200 pl-2 dark:border-neutral-700" : ""}>
      {entries.map(([key, item]) => (
        <div key={key} className="py-0.5">
          <span className="mr-1 break-all text-neutral-500 dark:text-neutral-400">{key}</span>
          <span className="mr-2 text-neutral-400">:</span>
          {isPrimitive(item) ? (
            <JsonValue value={item} depth={depth + 1} />
          ) : (
            <div className="mt-0.5">
              <JsonValue value={item} depth={depth + 1} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RawText({ text, maxHeightClassName }: { text: string; maxHeightClassName: string }) {
  return (
    <pre className={`${maxHeightClassName} overflow-auto whitespace-pre-wrap break-words rounded bg-white/70 px-2 py-1 dark:bg-neutral-900/60`}>
      {text}
    </pre>
  );
}

export function ToolCallPayloadView({
  value,
  emptyText,
  maxHeightClassName,
}: ToolCallPayloadViewProps) {
  const text = value?.trim();
  if (!text) {
    return <RawText text={emptyText} maxHeightClassName={maxHeightClassName} />;
  }

  const parsed = parseJson(text);
  if (!parsed.ok) {
    return <RawText text={text} maxHeightClassName={maxHeightClassName} />;
  }

  return (
    <div className={`${maxHeightClassName} overflow-auto rounded bg-white/70 px-2 py-1 font-mono text-[11px] leading-5 dark:bg-neutral-900/60`}>
      <JsonValue value={parsed.value} />
    </div>
  );
}
