import type { AgentDto, ConversationDto, ProjectDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import { AllAgentsView } from "../src/components/WorkspaceOverview";

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
describe("responsive workspace sidebar flow", () => {
  afterEach(() => vi.restoreAllMocks());

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
      route={{ kind: "conversation", projectId: "alpha", conversationId: "chat-alpha" }}
      notifications={[{ id: "unread", projectId: "beta", conversationId: "chat-beta", kind: "mentions", title: "Mention", body: "Review", createdAt: "2026-07-16T00:00:00.000Z" }]}
      onNavigate={onNavigate}
      onCreateProject={vi.fn()}
      onManageProject={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    /></QueryClientProvider>);

    expect(view.root.findAll((node) => node.type === "div" && node.props["data-testid"] === "workspace-navigation-scroll")).toHaveLength(1);
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain("All Projects");
    expect(rendered).toContain("Search Project Chats");
    expect(rendered).toContain("Website");
    expect(rendered).toContain("Release");

    act(() => view.root.findByProps({ "aria-label": "Projects" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "projects" });
    act(() => view.root.findByProps({ "aria-label": "Agents" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "allAgents" });
    act(() => view.root.findByProps({ "aria-label": "Open project files" }).props.onClick());
    expect(onNavigate).toHaveBeenCalledWith({ kind: "project", projectId: "alpha" });

    expect(view.root.findByProps({ "data-sidebar-state": "expanded" })).toBeTruthy();
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
    const view = create(<QueryClientProvider client={client}><AllAgentsView projects={projects} onNavigate={onNavigate} /></QueryClientProvider>);
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
});
