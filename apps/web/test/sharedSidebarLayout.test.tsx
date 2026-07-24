import type { AgentDto, ConversationDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import type { Route } from "../src/routing";

const project: ProjectDto = {
  id: "project-alpha",
  label: "Alpha",
  hostPath: "/repos/alpha",
  defaultEngine: "codex",
  createdAt: "2026-07-01T00:00:00.000Z",
  lastUsedAt: "2026-07-20T00:00:00.000Z",
};
const conversation: ConversationDto = {
  id: "chat-alpha",
  projectId: project.id,
  title: "Release planning",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  archived: false,
};
const agent: AgentDto = {
  id: "agent-alpha",
  projectId: project.id,
  title: "Reviewer",
  conversationIds: [conversation.id],
  activeEngine: "codex",
  state: {},
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  archived: false,
};
const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  homeSort: "last_used",
  homeOrder: [],
  chatSort: "last_used",
  chatOrder: [],
  agentSort: "last_used",
  agentOrder: [],
  triggerSort: "last_used",
  triggerOrder: [],
  starredProjectIds: [project.id],
  starredResourceIds: [`project:${project.id}`, `agent:${agent.id}`],
  sidebarCollapsed: false,
  sidebarWidth: 390,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter",
  providerAvailability: {},
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  onboardingCompletedAt: "2026-07-20T00:00:00.000Z",
  profile: { displayName: "Patrick", handle: "pto", avatarId: "default-user" },
  updatedAt: "2026-07-20T00:00:00.000Z",
} as WorkspacePreferencesDto;

function createClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["conversations", project.id], [conversation]);
  client.setQueryData(["agents", project.id], [agent]);
  client.setQueryData(["agent-health", project.id], {
    scope: { type: "project", id: project.id },
    generatedAt: "2026-07-20T00:00:00.000Z",
    agents: [{ agentId: agent.id, childAgentIds: [], status: "idle", statusTimestamp: "2026-07-20T00:00:00.000Z", reason: "no_active_work" }],
  });
  client.setQueryData(["triggers"], [{
    id: "trigger-alpha",
    projectId: project.id,
    conversationId: conversation.id,
    agentId: agent.id,
    name: "Release monitor",
    instructions: "Check the release",
    sourceKind: "webhook",
    sourceConfig: { kind: "webhook" },
    enabled: true,
    fullAccess: true,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  }]);
  client.setQueryData(["wiki", "index"], {
    sections: [{ id: "guides", title: "Guides", articles: [{ id: "start", title: "Getting Started", summary: "Start here" }] }],
  });
  return client;
}

function renderSidebar(route: Route, options: {
  onNavigate?: ReturnType<typeof vi.fn>;
  onCreateProject?: ReturnType<typeof vi.fn>;
  onCreateChat?: ReturnType<typeof vi.fn>;
  onCreateAgent?: ReturnType<typeof vi.fn>;
  onCreateTrigger?: ReturnType<typeof vi.fn>;
  onPreferences?: ReturnType<typeof vi.fn>;
} = {}): { view: ReactTestRenderer; client: QueryClient } {
  const client = createClient();
  const view = create(<QueryClientProvider client={client}><WorkspaceSidebar
    projects={[project]}
    preferences={preferences}
    route={route}
    notifications={[]}
    onNavigate={options.onNavigate ?? vi.fn()}
    onCreateProject={options.onCreateProject ?? vi.fn()}
    onCreateChat={options.onCreateChat ?? vi.fn()}
    onCreateAgent={options.onCreateAgent ?? vi.fn()}
    onCreateTrigger={options.onCreateTrigger ?? vi.fn()}
    onPreferences={options.onPreferences ?? vi.fn()}
    onRenameConversation={vi.fn()}
    onDeleteConversation={vi.fn()}
  /></QueryClientProvider>);
  return { view, client };
}

describe("shared global resource sidebar", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [{ kind: "home" } as Route, "home", "Search Home", "New", "View Home"],
    [{ kind: "projects" } as Route, "projects", "Search projects", "New Project", "View All Projects"],
    [{ kind: "allChats" } as Route, "chats", "Search chats", "New Chat", "View All Chats"],
    [{ kind: "allAgents" } as Route, "agents", "Search agents", "New Agent", "View All Agents"],
    [{ kind: "allTriggers" } as Route, "triggers", "Search triggers or agents", "New Trigger", "View All Triggers"],
  ])("uses the shared layout for %s", (route, panel, search, createLabel, viewAllLabel) => {
    const { view, client } = renderSidebar(route);
    expect(view.root.findByProps({ "data-sidebar-layout": "shared-resource", "data-sidebar-panel": panel })).toBeTruthy();
    expect(view.root.findByProps({ "aria-label": search })).toBeTruthy();
    expect(view.root.findAllByProps({ "data-sidebar-section": "starred" }).length).toBeGreaterThan(0);
    expect(view.root.findAllByProps({ "data-sidebar-section": "all" }).length).toBeGreaterThan(0);
    expect(view.root.findByProps({ children: createLabel })).toBeTruthy();
    expect(view.root.findByProps({ children: viewAllLabel })).toBeTruthy();
    view.unmount();
    client.clear();
  });

  it("filters only the open sidebar and reuses creation, routing, and sort callbacks", async () => {
    const onNavigate = vi.fn();
    const onCreateProject = vi.fn();
    const onPreferences = vi.fn();
    const { view, client } = renderSidebar({ kind: "projects" }, { onNavigate, onCreateProject, onPreferences });

    await act(async () => undefined);
    const searchField = view.root.find((node) => node.props.placeholder === "Search projects" && typeof node.props.onChange === "function");
    act(() => searchField.props.onChange({ target: { value: "missing" } }));
    expect(JSON.stringify(view.toJSON())).toContain("No projects match");
    act(() => view.root.findByProps({ children: "New Project" }).props.onClick({}));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
    act(() => view.root.findByProps({ children: "View All Projects" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "projects" });
    expect(view.root.findByProps({ "aria-label": "Sort resources" }).props.onClick).toEqual(expect.any(Function));
    expect(JSON.stringify(view.toJSON())).toContain("Recent Activity");
    view.unmount();
    client.clear();
  });

  it("opens and collapses spine sections without changing the current workspace route", () => {
    const client = createClient();
    const onNavigate = vi.fn();
    function Harness(): JSX.Element {
      const [collapsed, setCollapsed] = useState(true);
      return <WorkspaceSidebar
        projects={[project]} preferences={preferences}
        route={{ kind: "conversation", projectId: project.id, conversationId: conversation.id }}
        notifications={[]} collapsed={collapsed} onCollapsedChange={setCollapsed}
        onNavigate={onNavigate} onCreateProject={vi.fn()} onPreferences={vi.fn()}
        onRenameConversation={vi.fn()} onDeleteConversation={vi.fn()}
      />;
    }
    const view = create(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);

    act(() => view.root.findByProps({ "aria-label": "Agents" }).props.onClick());
    expect(view.root.findByProps({ "data-sidebar-state": "expanded" })).toBeTruthy();
    expect(view.root.findByProps({ "data-sidebar-panel": "agents" })).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    act(() => view.root.findByProps({ "aria-label": "Agents" }).props.onClick());
    expect(view.root.findByProps({ "data-sidebar-state": "collapsed" })).toBeTruthy();
    act(() => view.root.findByProps({ "aria-label": "Chats" }).props.onClick());
    expect(view.root.findByProps({ "data-sidebar-panel": "chats" })).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });

  it("keeps project routes in the shared sidebar while preserving Wiki and Settings panels", () => {
    const projectView = renderSidebar({ kind: "conversation", projectId: project.id, conversationId: conversation.id });
    expect(projectView.view.root.findByProps({ "data-sidebar-layout": "shared-resource", "data-sidebar-panel": "home" })).toBeTruthy();
    expect(projectView.view.root.findByProps({ "aria-label": "Search Home" })).toBeTruthy();
    expect(projectView.view.root.findAllByProps({ "aria-label": "Search Project Chats" })).toHaveLength(0);
    projectView.view.unmount();
    projectView.client.clear();

    const wikiView = renderSidebar({ kind: "wiki" });
    expect(wikiView.view.root.findAllByProps({ "data-sidebar-layout": "shared-resource" })).toHaveLength(0);
    expect(wikiView.view.root.findByProps({ "aria-label": "Wiki navigation" })).toBeTruthy();
    wikiView.view.unmount();
    wikiView.client.clear();

    const settingsView = renderSidebar({ kind: "settings" });
    expect(settingsView.view.root.findAllByProps({ "data-sidebar-layout": "shared-resource" })).toHaveLength(0);
    expect(settingsView.view.root.findByProps({ children: "General" })).toBeTruthy();
    settingsView.view.unmount();
    settingsView.client.clear();
  });
});
