import type { AgentDto, ConversationDto, EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalSearchShortcutAccessibleLabel, globalSearchShortcutLabel, operatorInitials, projectHealthDetail, projectHealthPresentation, WorkspaceSidebar } from "../src/components/WorkspaceSidebar";

const projects: ProjectDto[] = [
  { id: "alpha", label: "Website", hostPath: "/repos/alpha", defaultEngine: "codex", createdAt: "2026-07-01T00:00:00.000Z" },
  { id: "beta", label: "Website", hostPath: "/repos/beta", defaultEngine: "codex", createdAt: "2026-07-02T00:00:00.000Z" },
];
const conversations: ConversationDto[] = [
  { id: "chat-alpha", projectId: "alpha", title: "Release", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", archived: false },
  { id: "chat-beta", projectId: "beta", title: "Release", createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z", archived: false },
];
const agents: AgentDto[] = [
  { id: "agent-alpha", projectId: "alpha", title: "Reviewer", conversationIds: ["chat-alpha"], activeEngine: "codex", state: {}, createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z", archived: false },
  { id: "agent-beta", projectId: "beta", title: "Reviewer", conversationIds: ["chat-beta"], activeEngine: "codex", state: {}, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z", archived: false },
];
const engineRoster: EngineDto[] = [
  { id: "codex", displayName: "Codex", models: [], efforts: [], configured: true, enabled: true, authenticated: true, available: true },
  { id: "claude", displayName: "Claude", models: [], efforts: [], configured: true, enabled: true, authenticated: true, available: false, availabilityDetail: "Subscription access is inactive." },
];
const preferences: WorkspacePreferencesDto = {
  projectSort: "last_used", projectOrder: [], starredProjectIds: ["alpha"], sidebarCollapsed: false, sidebarWidth: 320,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter", providerAvailability: {}, globalInstructions: "", profile: { displayName: "User", handle: "operator", avatarId: "default-user" }, updatedAt: "2026-07-17T00:00:00.000Z",
};
describe("responsive workspace sidebar flow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives project health labels from the canonical health projection", () => {
    expect(projectHealthPresentation(undefined)).toEqual({ label: "Checking", color: "text.disabled" });
    expect(projectHealthPresentation([])).toEqual({ label: "Healthy", color: "success.main" });
    expect(projectHealthPresentation([{ agentId: "a", childAgentIds: [], status: "running", statusTimestamp: "2026-07-18T00:00:00.000Z", reason: "active_run" }])).toEqual({ label: "Active", color: "info.main" });
    expect(projectHealthPresentation([{ agentId: "a", childAgentIds: [], status: "stalled", statusTimestamp: "2026-07-18T00:00:00.000Z", reason: "runtime_event_consumer_stalled" }])).toEqual({ label: "Needs attention", color: "error.main" });
  });

  it("does not let an inactive secondary provider make an operational project unhealthy", () => {
    const claudeAgent: AgentDto = { ...agents[0]!, id: "claude-agent", activeEngine: "claude" };
    const failed = [{ agentId: claudeAgent.id, childAgentIds: [], status: "failed" as const, statusTimestamp: "2026-07-18T00:00:00.000Z", reason: "runtime_error" }];
    expect(projectHealthPresentation(failed, [claudeAgent], engineRoster)).toEqual({ label: "Healthy", color: "success.main" });
    expect(projectHealthDetail(failed, [claudeAgent], engineRoster)).toContain("1 agent failure is tied to an unavailable engine");
    expect(projectHealthDetail(failed, [claudeAgent], engineRoster)).toContain("Claude is unavailable");
    expect(projectHealthPresentation(failed, [{ ...claudeAgent, activeEngine: "codex" }], engineRoster)).toEqual({ label: "Needs attention", color: "error.main" });
    expect(projectHealthPresentation(failed, [claudeAgent], engineRoster.map((item) => ({ ...item, available: false })))).toEqual({ label: "Healthy", color: "success.main" });
    expect(projectHealthPresentation(failed, [claudeAgent], engineRoster.map((item) => ({ ...item, enabled: false, available: false })))).toEqual({ label: "Healthy", color: "success.main" });
  });

  it("keeps one project-scoped chat navigator and persistent global destinations", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    projects.forEach((project, index) => {
      client.setQueryData(["conversations", project.id], [conversations[index]]);
      client.setQueryData(["agents", project.id], [agents[index]]);
      client.setQueryData(["agent-health", project.id], {
        scope: { type: "project", id: project.id }, generatedAt: "2026-07-16T00:00:00.000Z",
        agents: [{ agentId: agents[index]!.id, childAgentIds: [], status: index === 0 ? "running" : "idle", statusTimestamp: "2026-07-16T00:00:00.000Z", reason: index === 0 ? "active_run" : "no_active_work" }],
      });
    });
    const onNavigate = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects}
      engines={engineRoster}
      preferences={preferences}
      route={{ kind: "conversation", projectId: "alpha", conversationId: "chat-alpha" }}
      notifications={[{ id: "unread", projectId: "beta", conversationId: "chat-beta", kind: "mentions", title: "Mention", body: "Review", createdAt: "2026-07-16T00:00:00.000Z" }]}
      onNavigate={onNavigate}
      onCreateProject={vi.fn()}
      onManageProject={vi.fn()}
      onPreferences={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    /></QueryClientProvider>);

    expect(view.root.findAll((node) => node.type === "div" && node.props["data-testid"] === "workspace-navigation-scroll")).toHaveLength(1);
    const rendered = JSON.stringify(view.toJSON());
    expect(view.root.findAll((node) => node.props["aria-label"] === "Home")).toHaveLength(0);
    expect(view.root.findByProps({ "aria-label": "All Chat" })).toBeTruthy();
    expect(rendered).toContain("Search Project Chats");
    expect(rendered).toContain("Website");
    expect(rendered).toContain("Release");
    expect(view.root.findAll((node) => node.props.color === "info" && node.props.badgeContent === 1)).toHaveLength(1);
    expect(view.root.findAll((node) => node.props.color === "error" && node.props.badgeContent === 1)).toHaveLength(1);

    act(() => view.root.findByProps({ "aria-label": "Projects" }).props.onClick());
    expect(onNavigate).not.toHaveBeenCalledWith({ kind: "projects" });
    expect(JSON.stringify(view.toJSON())).toContain("Search projects");
    expect(JSON.stringify(view.toJSON())).not.toContain("Search Project Chats");
    expect(JSON.stringify(view.toJSON())).toContain("View All Projects");
    act(() => view.root.findByProps({ children: "View All Projects" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "projects" });
    act(() => view.root.findAllByProps({ "aria-label": "Open project Website" })[0]!.props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "conversation", projectId: "alpha", conversationId: "chat-alpha" });
    act(() => view.root.findByProps({ "aria-label": "Open project overview" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "project", projectId: "alpha" });
    act(() => view.root.findByProps({ "aria-label": "Open project agents" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "agents", projectId: "alpha" });
    act(() => view.root.findByProps({ "aria-label": "Agents" }).props.onClick());
    expect(onNavigate).not.toHaveBeenCalledWith({ kind: "allAgents" });
    expect(JSON.stringify(view.toJSON())).toContain("Search agents");
    expect(JSON.stringify(view.toJSON())).toContain("Reviewer");
    await act(async () => view.root.findByProps({ "aria-label": "Triggers" }).props.onClick());
    expect(onNavigate).not.toHaveBeenCalledWith({ kind: "allAgents" });
    expect(JSON.stringify(view.toJSON())).toContain("Search triggers or agents");
    act(() => view.root.findAllByProps({ "aria-label": "Open triggers for Reviewer" })[0]!.props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "agent", projectId: "alpha", agentId: "agent-alpha", view: "triggers" });

    expect(view.root.findByProps({ "data-sidebar-state": "expanded" })).toBeTruthy();
    view.unmount();
    client.clear();
  });

  it("puts global search in its own sidebar icon with an OS-aware accessible shortcut", () => {
    expect(globalSearchShortcutLabel("MacIntel")).toBe("⌘K");
    expect(globalSearchShortcutLabel("Win32")).toBe("Ctrl K");
    expect(globalSearchShortcutAccessibleLabel("MacIntel")).toBe("Command K");
    expect(globalSearchShortcutAccessibleLabel("Linux x86_64")).toBe("Control K");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    projects.forEach((project) => {
      client.setQueryData(["conversations", project.id], []);
      client.setQueryData(["agents", project.id], []);
      client.setQueryData(["agent-health", project.id], { scope: { type: "project", id: project.id }, generatedAt: "2026-07-16T00:00:00.000Z", agents: [] });
    });
    const onSearch = vi.fn();
    const render = (drawer = false) => create(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects} engines={engineRoster} preferences={preferences} route={{ kind: "projects" }} notifications={[]}
      drawer={drawer} onNavigate={vi.fn()} onCreateProject={vi.fn()} onManageProject={vi.fn()} onPreferences={vi.fn()}
      onRenameConversation={vi.fn()} onDeleteConversation={vi.fn()} onSearch={onSearch}
    /></QueryClientProvider>);
    const desktop = render();
    const search = desktop.root.findByProps({ "aria-label": `Search All Chats (${globalSearchShortcutAccessibleLabel()})` });
    act(() => search.props.onClick());
    expect(onSearch).toHaveBeenCalledOnce();
    expect(desktop.root.findAllByType("kbd")).toHaveLength(0);
    const mobile = render(true);
    expect(mobile.root.findByProps({ "aria-label": "Search All Chats" })).toBeTruthy();
    expect(mobile.root.findAllByType("kbd")).toHaveLength(0);
    desktop.unmount();
    mobile.unmount();
    client.clear();
  });

  it("derives the operator avatar from the synced name and makes it actionable", () => {
    expect(operatorInitials("Khaleel Clark")).toBe("KC");
    expect(operatorInitials("Patrick")).toBe("PA");
    expect(operatorInitials("   ")).toBe("U");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    projects.forEach((project) => {
      client.setQueryData(["conversations", project.id], []);
      client.setQueryData(["agents", project.id], []);
      client.setQueryData(["agent-health", project.id], { scope: { type: "project", id: project.id }, generatedAt: "2026-07-16T00:00:00.000Z", agents: [] });
    });
    const onOpenProfile = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects}
      engines={engineRoster}
      preferences={{ ...preferences, profile: { ...preferences.profile, displayName: "Khaleel Clark" } }}
      route={{ kind: "projects" }}
      notifications={[]}
      onNavigate={vi.fn()}
      onCreateProject={vi.fn()}
      onManageProject={vi.fn()}
      onPreferences={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      onOpenProfile={onOpenProfile}
    /></QueryClientProvider>);
    expect(view.root.findByProps({ "aria-label": "Khaleel Clark avatar" })).toBeTruthy();
    act(() => view.root.findByProps({ "aria-label": "Open operator profile" }).props.onClick());
    expect(onOpenProfile).toHaveBeenCalledOnce();
    view.unmount();
    client.clear();
  });

  it("renders duplicate agent names as distinct phone-friendly global destinations", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    projects.forEach((project, index) => {
      client.setQueryData(["conversations", project.id], [conversations[index]]);
      client.setQueryData(["agents", project.id], [agents[index]]);
      client.setQueryData(["agent-health", project.id], { scope: { type: "project", id: project.id }, generatedAt: "2026-07-16T00:00:00.000Z", agents: [] });
    });
    const onNavigate = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects}
      engines={engineRoster}
      preferences={preferences}
      route={{ kind: "projects" }}
      notifications={[]}
      onNavigate={onNavigate}
      onCreateProject={vi.fn()}
      onManageProject={vi.fn()}
      onPreferences={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    /></QueryClientProvider>);
    act(() => view.root.findByProps({ "aria-label": "Agents" }).props.onClick());
    const alphaDestination = view.root.findAll((node) => node.type === "div" && node.props["aria-label"] === "Open agent Reviewer in Website · /repos/alpha");
    const betaDestination = view.root.findAll((node) => node.type === "div" && node.props["aria-label"] === "Open agent Reviewer in Website · /repos/beta");
    expect(alphaDestination).toHaveLength(1);
    expect(betaDestination).toHaveLength(1);
    act(() => alphaDestination[0]!.props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "agent", projectId: "alpha", agentId: "agent-alpha" });
    expect(JSON.stringify(view.toJSON())).toContain("Website · /repos/alpha · codex");
    view.unmount();
    client.clear();
  });

  it("persists project stars and exposes the selected project sort", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    projects.forEach((project, index) => {
      client.setQueryData(["conversations", project.id], [conversations[index]]);
      client.setQueryData(["agents", project.id], []);
      client.setQueryData(["agent-health", project.id], { scope: { type: "project", id: project.id }, generatedAt: "2026-07-16T00:00:00.000Z", agents: [] });
    });
    const onPreferences = vi.fn();
    const view = create(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects}
      engines={engineRoster}
      preferences={preferences}
      route={{ kind: "projects" }}
      notifications={[]}
      onNavigate={vi.fn()}
      onCreateProject={vi.fn()}
      onManageProject={vi.fn()}
      onPreferences={onPreferences}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    /></QueryClientProvider>);

    act(() => view.root.findByProps({ "aria-label": "Unstar Website" }).props.onClick());
    expect(onPreferences).toHaveBeenCalledWith({ starredProjectIds: [] });
    const sortProjects = view.root.findByProps({ "aria-label": "Sort projects" });
    expect(sortProjects.props.onClick).toEqual(expect.any(Function));
    expect(JSON.stringify(view.toJSON())).toContain("Recent Activity");
    view.unmount();
    client.clear();
  });
});
