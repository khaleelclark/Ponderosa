import type {
  AgentDto,
  ConversationDetailDto,
  ConversationDraftDto,
  EngineComposerCapability,
  EngineDto,
  ProjectEngineCapabilitiesDto,
} from "@ponderosa/core";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  return {
    ...actual,
    ClickAwayListener: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <Fragment>{children}</Fragment> : null,
    Drawer: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <Fragment>{children}</Fragment> : null,
    Popper: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <Fragment>{children}</Fragment> : null,
    Select: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
    Tooltip: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
  };
});

import { api } from "../src/api";
import { chatStateKey } from "../src/chatState";
import { ConversationView } from "../src/components/ConversationView";
import { invalidateWorkspaceCapabilities } from "../src/hooks/useWorkspaceStream";

const projectId = "project-capabilities";
const conversationId = "conversation-capabilities";
const runtimeId = "runtime-selected";
const now = "2026-07-16T00:00:00.000Z";

const conversation = {
  id: conversationId,
  projectId,
  title: "Capability integration",
  defaultEngine: runtimeId,
  createdAt: now,
  updatedAt: now,
  archived: false,
};

const agent: AgentDto = {
  id: "agent-one",
  projectId,
  conversationId,
  conversationIds: [conversationId],
  title: "Agent One",
  activeEngine: runtimeId,
  state: "idle",
  createdAt: now,
  updatedAt: now,
  archived: false,
};

const engines: EngineDto[] = [{
  id: runtimeId,
  displayName: "Selected runtime",
  models: [],
  efforts: [],
  authenticated: true,
}];

const capability = (
  id: string,
  kind: EngineComposerCapability["kind"],
  label: string,
): EngineComposerCapability => ({
  id,
  kind,
  label,
  description: `${label} discovered by the runtime`,
  status: "available",
  ...(kind === "skill" ? { insertText: `$${label.toLocaleLowerCase().replaceAll(" ", "-")} ` } : {}),
});

const discovery = (...composerCapabilities: EngineComposerCapability[]): ProjectEngineCapabilitiesDto[] => [{
  engineId: runtimeId,
  steering: true,
  persistentSessions: true,
  commands: [],
  mcpServers: [],
  composerCapabilities,
}, {
  engineId: "runtime-not-selected",
  steering: true,
  persistentSessions: true,
  commands: [],
  mcpServers: [],
  composerCapabilities: [capability("skill:wrong-runtime", "skill", "Wrong runtime skill")],
}];

const draft = (id: string): ConversationDraftDto => ({
  conversationId: id,
  text: "",
  attachmentIds: [],
  revision: 0,
  updatedAt: now,
  clientId: "test-client",
});

function CapabilityConversation(): JSX.Element {
  const capabilities = useQuery({
    queryKey: ["engine-capabilities", projectId],
    queryFn: () => api.getEngineCapabilities(projectId),
    staleTime: 60_000,
  });
  return <ConversationView
    conversationId={conversationId}
    engines={engines}
    engineCapabilities={capabilities.data ?? []}
    onRefreshCapabilities={() => capabilities.refetch()}
    statusByAgentId={new Map()}
    healthByAgentId={new Map()}
    onOpenAgent={() => undefined}
    onNewAgent={() => undefined}
    onDeleted={() => undefined}
  />;
}

const buttons = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
const visibleText = (root: ReactTestInstance, text: string) =>
  root.findAll((node) => node.children.includes(text));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Project composer runtime capability refresh", () => {
  it("refreshes selected-runtime capabilities while Team chat remains read-only", async () => {
    const values = new Map<string, string>();
    values.set(chatStateKey("view", `conversation.${conversationId}`), "main");
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    vi.stubGlobal("window", {
      localStorage: storage,
      sessionStorage: storage,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
      cancelAnimationFrame: clearTimeout,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    let resolveMenuRefresh!: (value: ProjectEngineCapabilitiesDto[]) => void;
    const capabilityRequest = vi.spyOn(api, "getEngineCapabilities")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveMenuRefresh = resolve; }))
      .mockResolvedValueOnce(discovery(capability("connector:issues", "connector", "Issue tracker")))
      .mockResolvedValueOnce(discovery(capability("skill:reconnected", "skill", "Reconnected skill")));
    vi.spyOn(api, "getConversationDraft").mockImplementation(async (id) => draft(id));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    client.setQueryData(["engine-capabilities", projectId], discovery(capability("skill:initial", "skill", "Initial skill")));
    client.setQueryData<ConversationDetailDto>(["conversation", conversationId], {
      conversation,
      messages: [],
      agents: [agent],
    });
    client.setQueryData(["collaboration-chat", conversationId], { messages: [], agents: [agent] });
    client.setQueryData(["queued-messages", conversationId], []);

    const view = create(<QueryClientProvider client={client}><CapabilityConversation /></QueryClientProvider>);

    expect(buttons(view.root, "Switch to team chat")).toHaveLength(1);

    buttons(view.root, "Add attachment or capability")[0]!.props.onClick({ currentTarget: {} });
    await vi.waitFor(() => {
      expect(capabilityRequest).toHaveBeenCalledTimes(1);
      expect(visibleText(view.root, "Initial skill")).not.toHaveLength(0);
      expect(visibleText(view.root, "Wrong runtime skill")).toHaveLength(0);
    });

    resolveMenuRefresh(discovery(
      capability("skill:new-review", "skill", "New review skill"),
      capability("plugin:team-tools", "plugin", "Team tools plugin"),
    ));
    await vi.waitFor(() => {
      expect(visibleText(view.root, "New review skill")).not.toHaveLength(0);
      expect(visibleText(view.root, "Team tools plugin")).not.toHaveLength(0);
    });

    await invalidateWorkspaceCapabilities(client, { kind: "runtime-change", projectId });
    await vi.waitFor(() => {
      expect(capabilityRequest).toHaveBeenCalledTimes(2);
      expect(visibleText(view.root, "Issue tracker")).not.toHaveLength(0);
      expect(visibleText(view.root, "New review skill")).toHaveLength(0);
    });

    await invalidateWorkspaceCapabilities(client, { kind: "reconnect" });
    await vi.waitFor(() => {
      expect(capabilityRequest).toHaveBeenCalledTimes(3);
      expect(visibleText(view.root, "Reconnected skill")).not.toHaveLength(0);
      expect(visibleText(view.root, "Issue tracker")).toHaveLength(0);
    });

    buttons(view.root, "Switch to team chat")[0]!.props.onClick();
    await vi.waitFor(() => {
      expect(visibleText(view.root, "Team chat is a read-only audit trail of agent-to-agent coordination. Message an agent from its Agent chat; collaboration will appear here automatically.")).not.toHaveLength(0);
      expect(buttons(view.root, "Add attachment or capability")).toHaveLength(0);
    });

    view.unmount();
    client.clear();
  });
});
