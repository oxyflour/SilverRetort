import type { ToolCall } from "silverretort-protocol";

export interface ToolCallTodo {
  text: string;
  status: string;
}

const todoToolNames = ["update_plan", "todowrite", "todo_write"];

export function isTodoTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "todo" ||
    normalized.endsWith(".todo") ||
    normalized.endsWith("__todo") ||
    todoToolNames.some((toolName) => normalized.includes(toolName))
  );
}

function parseJson(value: string | null | undefined): unknown {
  if (!value?.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function todoArray(value: unknown): unknown[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.plan)) {
    return record.plan;
  }
  if (Array.isArray(record.todos)) {
    return record.todos;
  }
  return null;
}

function normalizeTodos(value: unknown): ToolCallTodo[] {
  const items = todoArray(value);
  if (!items) {
    return [];
  }
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const text = record.step ?? record.content ?? record.title;
    if (typeof text !== "string" || !text.trim()) {
      return [];
    }
    return [{
      text: text.trim(),
      status: typeof record.status === "string" ? record.status : "pending",
    }];
  });
}

function hasMergeFlag(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const merge = (value as Record<string, unknown>).merge;
  return merge === true || merge === "true";
}

export function hasTodoMerge(toolCall: ToolCall): boolean {
  if (!isTodoTool(toolCall.name)) {
    return false;
  }
  return (
    hasMergeFlag(parseJson(toolCall.detail)) ||
    hasMergeFlag(parseJson(toolCall.result))
  );
}

export function getToolCallTodos(toolCalls: ToolCall[]): ToolCallTodo[] {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index]!;
    if (!isTodoTool(toolCall.name)) {
      continue;
    }
    const detailTodos = normalizeTodos(parseJson(toolCall.detail));
    if (detailTodos.length > 0) {
      return detailTodos;
    }
    const resultTodos = normalizeTodos(parseJson(toolCall.result));
    if (resultTodos.length > 0) {
      return resultTodos;
    }
  }
  return [];
}
