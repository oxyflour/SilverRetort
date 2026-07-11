import type { Artifact, Message } from "silverretort-protocol";

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
  hasFollowingMessages: boolean;
}

const collapsedDetailLimit = 240;

export function collapsedDetail(detail: string): string {
  return detail.length > collapsedDetailLimit
    ? `${detail.slice(0, collapsedDetailLimit)}…`
    : detail;
}
