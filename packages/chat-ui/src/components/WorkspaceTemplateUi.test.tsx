import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Workspace, WorkspaceTemplate } from "silverretort-protocol";
import type { WorkspaceTemplateModule } from "silverretort-template-sdk";
import { ChatPaneToolbarSlot, EmptySessionSlot } from "../templateSlots";
import { useChatStore } from "../store";
import { EmptySessionGuide } from "./EmptySessionGuide";
import { SessionSidebar } from "./SessionSidebar";

const resolveTemplateModule = vi.hoisted(() => vi.fn());

vi.mock("../templateModules", () => ({
  getWorkspaceTemplateModule: resolveTemplateModule,
}));
vi.mock("silverretort-setting-ui", () => ({ UserSettingsPanel: () => null }));

const template: WorkspaceTemplate = {
  version: 1,
  id: "structural-design",
  name: "Structural design",
  description: "Structural design workflow",
  emptyState: {
    title: "Start structural design",
    description: "Define constraints first",
    suggestions: [{ label: "Define loads", prompt: "List all loads" }],
  },
  ui: { module: "structural-design" },
};

const workspace: Workspace = {
  id: "workspace-a",
  name: "Workspace",
  templateId: template.id,
  status: "active",
  connectionId: "local",
  switchMode: "local",
  switchUrl: "",
  hasHermesApiKey: false,
  createdAt: "2026-07-20T00:00:00Z",
  updatedAt: "2026-07-20T00:00:00Z",
};

const message: Message = {
  id: "message-a",
  sessionId: "session-a",
  role: "assistant",
  parts: [{ type: "text", text: "Result" }],
  attachments: [],
  artifactIds: [],
  status: "complete",
  createdAt: "2026-07-20T00:00:00Z",
};

const toolbarProps = {
  workspace,
  template,
  session: {
    id: "session-a",
    workspaceId: workspace.id,
    title: "Design session",
    createdAt: "2026-07-20T00:00:00Z",
    updatedAt: "2026-07-20T00:00:00Z",
  },
  messages: [message],
  artifacts: [],
  running: false,
  setDraft: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

describe("workspace template UI", () => {
  beforeEach(() => {
    resolveTemplateModule.mockReset();
  });

  it("fills the composer callback without sending when a suggestion is selected", async () => {
    const user = userEvent.setup();
    const onSelectSuggestion = vi.fn();
    render(
      <EmptySessionGuide
        hasSession
        template={template}
        onSelectSuggestion={onSelectSuggestion}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Define loads" }));

    expect(onSelectSuggestion).toHaveBeenCalledWith("List all loads");
    expect(onSelectSuggestion).toHaveBeenCalledTimes(1);
  });

  it("provides host state and commands to a template toolbar", async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    const templateModule: WorkspaceTemplateModule = {
      apiVersion: 1,
      id: template.id,
      components: {
        chatPaneToolbar: (props) => (
          <header>
            <span>{props.template.name}</span>
            <span>{props.messages.length} messages</span>
            <button onClick={() => props.setDraft("toolbar prompt")}>Run tool</button>
          </header>
        ),
      },
    };
    resolveTemplateModule.mockReturnValue(templateModule);

    render(<ChatPaneToolbarSlot {...toolbarProps} setDraft={setDraft} />);
    await user.click(screen.getByRole("button", { name: "Run tool" }));

    expect(screen.getByText("Structural design")).toBeInTheDocument();
    expect(screen.getByText("1 messages")).toBeInTheDocument();
    expect(setDraft).toHaveBeenCalledWith("toolbar prompt");
  });

  it("allows a template module to replace the empty session view", async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    resolveTemplateModule.mockReturnValue({
      apiVersion: 1,
      id: template.id,
      components: {
        emptySession: (props) => (
          <button onClick={() => props.setDraft(props.suggestions[0].prompt)}>
            Custom empty session
          </button>
        ),
      },
    } satisfies WorkspaceTemplateModule);

    render(
      <EmptySessionSlot
        hasSession
        workspace={workspace}
        template={template}
        session={toolbarProps.session}
        setDraft={setDraft}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Custom empty session" }));

    expect(setDraft).toHaveBeenCalledWith("List all loads");
    expect(screen.queryByText("Start structural design")).not.toBeInTheDocument();
  });

  it("falls back to the default toolbar for missing and failed modules", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveTemplateModule.mockReturnValue(undefined);
    const { rerender } = render(<ChatPaneToolbarSlot {...toolbarProps} />);
    expect(screen.getByRole("banner")).toHaveTextContent("Workspace");

    resolveTemplateModule.mockReturnValue({
      apiVersion: 1,
      id: template.id,
      components: {
        chatPaneToolbar: () => {
          throw new Error("toolbar failed");
        },
      },
    } satisfies WorkspaceTemplateModule);
    rerender(<ChatPaneToolbarSlot {...toolbarProps} />);

    expect(screen.getByRole("banner")).toHaveTextContent("Workspace");
    consoleError.mockRestore();
  });

  it("passes the selected domain when creating a workspace", async () => {
    const user = userEvent.setup();
    const createWorkspace = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      workspaces: [],
      workspaceTemplates: [template],
      switchProfiles: [{
        id: "local",
        name: "Local",
        mode: "local",
        switchUrl: "",
        hasHermesApiKey: false,
      }],
      createWorkspace,
    });
    render(<SessionSidebar />);

    await user.click(screen.getByRole("button", { name: "New workspace" }));
    await user.selectOptions(screen.getByLabelText("\u5e94\u7528\u9886\u57df"), template.id);
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(createWorkspace).toHaveBeenCalledWith(
      "New workspace",
      "local",
      template.id,
    );
  });
});
