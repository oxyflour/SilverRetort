"use client";

import { Component, type ReactNode } from "react";
import type {
  Artifact,
  Message,
  Session,
  Workspace,
  WorkspaceTemplate,
} from "silverretort-protocol";
import { getWorkspaceTemplateModule } from "./templateModules";
import { DefaultChatPaneToolbar } from "./components/DefaultChatPaneToolbar";
import { EmptySessionGuide } from "./components/EmptySessionGuide";

interface TemplateBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

class TemplateBoundary extends Component<
  TemplateBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface ChatPaneToolbarSlotProps {
  workspace: Workspace;
  template?: WorkspaceTemplate;
  session: Session | null;
  messages: Message[];
  artifacts: Artifact[];
  running: boolean;
  setDraft: (prompt: string) => void;
  sendMessage: (text: string) => Promise<void>;
}

export function ChatPaneToolbarSlot(props: ChatPaneToolbarSlotProps) {
  if (!props.template) return null;

  const defaultToolbar = (
    <DefaultChatPaneToolbar
      workspace={props.workspace}
      template={props.template}
      session={props.session}
      messages={props.messages}
      artifacts={props.artifacts}
      running={props.running}
    />
  );

  const templateModule = getWorkspaceTemplateModule(props.template.ui.module);
  const Toolbar = templateModule?.components?.chatPaneToolbar;
  if (!Toolbar) return defaultToolbar;

  return (
    <TemplateBoundary
      key={`${templateModule.id}:toolbar`}
      fallback={defaultToolbar}
    >
      <Toolbar
        workspace={props.workspace}
        template={props.template}
        session={props.session}
        messages={props.messages}
        artifacts={props.artifacts}
        running={props.running}
        defaultToolbar={defaultToolbar}
        setDraft={props.setDraft}
        sendMessage={props.sendMessage}
      />
    </TemplateBoundary>
  );
}

interface EmptySessionSlotProps {
  hasSession: boolean;
  workspace?: Workspace;
  template?: WorkspaceTemplate;
  session: Session | null;
  setDraft: (prompt: string) => void;
}

export function EmptySessionSlot(props: EmptySessionSlotProps) {
  const fallback = (
    <EmptySessionGuide
      hasSession={props.hasSession}
      template={props.template}
      onSelectSuggestion={props.setDraft}
    />
  );
  if (!props.workspace || !props.template) return fallback;

  const templateModule = getWorkspaceTemplateModule(props.template.ui.module);
  const EmptySession = templateModule?.components?.emptySession;
  if (!EmptySession) return fallback;

  return (
    <TemplateBoundary
      key={`${templateModule.id}:empty-session`}
      fallback={fallback}
    >
      <EmptySession
        workspace={props.workspace}
        template={props.template}
        session={props.session}
        suggestions={props.template.emptyState.suggestions}
        setDraft={props.setDraft}
      />
    </TemplateBoundary>
  );
}
