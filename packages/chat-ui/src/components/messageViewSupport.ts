import type {
  Artifact,
  Message,
  MessagePart,
  ToolCall,
} from "silverretort-protocol";

export interface MessageViewContext {
  artifacts: Record<string, Artifact>;
  running: boolean;
  sessionMessages: Message[];
  sessionArtifactIds: string[];
  artifactCreatedAtById: Record<string, string>;
}

export interface MessageViewProps {
  message: Message;
  context: MessageViewContext;
}

export type MessagePartGroup =
  | { type: "text"; part: Extract<MessagePart, { type: "text" }>; index: number }
  | {
      type: "artifact-context";
      part: Extract<
        MessagePart,
        { type: "artifact-input" | "artifact-context" }
      >;
      index: number;
    }
  | { type: "tools"; toolCalls: ToolCall[]; index: number };

function isBlankTextPart(part: MessagePart | undefined): boolean {
  return part?.type === "text" && part.text.trim().length === 0;
}

export function groupConsecutiveToolCalls(parts: MessagePart[]): MessagePartGroup[] {
  const groups: MessagePartGroup[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type === "text") {
      groups.push({ type: "text", part, index });
      continue;
    }
    if (part.type === "artifact-input" || part.type === "artifact-context") {
      groups.push({ type: "artifact-context", part, index });
      continue;
    }

    const startIndex = index;
    const toolCalls: ToolCall[] = [];
    let nextIndex = index;

    while (nextIndex < parts.length) {
      const nextPart = parts[nextIndex]!;
      if (nextPart.type === "tool") {
        toolCalls.push(nextPart.toolCall);
        nextIndex += 1;
        continue;
      }

      if (isBlankTextPart(nextPart) && parts[nextIndex + 1]?.type === "tool") {
        nextIndex += 1;
        continue;
      }

      break;
    }

    groups.push({ type: "tools", toolCalls, index: startIndex });
    index = nextIndex - 1;
  }

  return groups;
}

function isShowArtifactTool(toolName: string): boolean {
  return toolName.includes("ui_show_artifact");
}

function parseArtifactResultValue(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("error:")) {
      return null;
    }

    try {
      return parseArtifactResultValue(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const artifactId =
    typeof payload.artifactId === "string"
      ? payload.artifactId
      : typeof payload.id === "string"
        ? payload.id
        : null;
  if (artifactId) {
    return artifactId;
  }

  if ("result" in payload) {
    return parseArtifactResultValue(payload.result, depth + 1);
  }

  return null;
}

function parseArtifactResult(result: string | null | undefined): string | null {
  return parseArtifactResultValue(result);
}

export function inferArtifactIdFromMessageWindow(
  toolCall: ToolCall,
  message: Message,
  sessionMessages: Message[],
  sessionArtifactIds: string[],
  artifactCreatedAtById: Record<string, string>,
): string | null {
  if (!isShowArtifactTool(toolCall.name)) {
    return null;
  }

  const explicitArtifactId = parseArtifactResult(toolCall.result);
  if (explicitArtifactId) {
    return explicitArtifactId;
  }
  if (message.artifactIds.length > 0) {
    return message.artifactIds[0] ?? null;
  }

  const currentMessageIndex = sessionMessages.findIndex(
    (currentMessage) => currentMessage.id === message.id,
  );
  const currentTimestamp = Date.parse(message.createdAt) || 0;
  const nextTimestamp =
    currentMessageIndex >= 0 && currentMessageIndex + 1 < sessionMessages.length
      ? Date.parse(sessionMessages[currentMessageIndex + 1]!.createdAt) || 0
      : Number.POSITIVE_INFINITY;

  return (
    sessionArtifactIds.find((artifactId) => {
      const createdAt = artifactCreatedAtById[artifactId];
      if (!createdAt) {
        return false;
      }
      const artifactTimestamp = Date.parse(createdAt) || 0;
      return artifactTimestamp >= currentTimestamp && artifactTimestamp < nextTimestamp;
    }) ?? null
  );
}

export function getShownArtifactId(toolCall: ToolCall): string | null {
  if (toolCall.status !== "done" || !isShowArtifactTool(toolCall.name)) {
    return null;
  }
  return parseArtifactResult(toolCall.result);
}

export function messageText(message: Message): string {
  return message.parts.reduce(
    (text, part) => {
      if (part.type === "text") {
        return text + part.text;
      }
      if (part.type === "artifact-input" || part.type === "artifact-context") {
        const summary = part.displayText ?? part.action;
        const data = JSON.stringify(part.data, null, 2);
        return `${text}${summary}\n${data}`;
      }
      return text;
    },
    "",
  );
}

export function toRestartErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Save failed. Please try again.";
  }
  if (error.message.includes("HTTP 409")) {
    return "This session is still running. Try again after it stops.";
  }
  if (error.message.includes("HTTP 400")) {
    return "Only user messages can be edited and restarted.";
  }
  if (error.message.includes("HTTP 404")) {
    return "The target message no longer exists.";
  }
  return error.message;
}

const collapsedDetailLimit = 240;

export function collapsedDetail(detail: string): string {
  return detail.length > collapsedDetailLimit
    ? `${detail.slice(0, collapsedDetailLimit)}…`
    : detail;
}
