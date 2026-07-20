import type { ComponentType, ReactNode } from "react";
import type {
  Artifact,
  Message,
  Session,
  Workspace,
  WorkspaceTemplate,
  WorkspaceTemplateSuggestion,
} from "silverretort-protocol";

export const WORKSPACE_TEMPLATE_API_VERSION = 1 as const;

export interface ChatPaneToolbarProps {
  workspace: Workspace;
  template: WorkspaceTemplate;
  session: Session | null;
  messages: Message[];
  artifacts: Artifact[];
  running: boolean;
  defaultToolbar: ReactNode;
  setDraft: (prompt: string) => void;
  sendMessage: (text: string) => Promise<void>;
}

export interface EmptySessionProps {
  workspace: Workspace;
  template: WorkspaceTemplate;
  session: Session | null;
  suggestions: WorkspaceTemplateSuggestion[];
  setDraft: (prompt: string) => void;
}

export interface WorkspaceTemplateModule {
  apiVersion: typeof WORKSPACE_TEMPLATE_API_VERSION;
  id: string;
  components?: {
    chatPaneToolbar?: ComponentType<ChatPaneToolbarProps>;
    emptySession?: ComponentType<EmptySessionProps>;
  };
}
