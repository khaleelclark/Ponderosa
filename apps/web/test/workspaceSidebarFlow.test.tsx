import type { AgentDto, ConversationDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";

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
  starredProjectIds: ["alpha"],
  starredResourceIds: ["project:alpha", "agent:agent-alpha"],
  sidebarCollapsed: false,
  sidebarWidth: 320,
  notifications: { mentions: true, directReplies: true, projectChatMessages: true, broadcasts: true, allMessages: false },
  fontFamily: "inter",
  providerAvailability: {},
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  onboardingCompletedAt: "2026-07-17T00:00:00.000Z",
  profile: { displayName: "User", handle: "operator", avatarId: "default-user" },
  updatedAt: "2026-07-17T00:00:00.000Z",
} as WorkspacePreferencesDto;

function clientWithWorkspace(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  projects.forEach((project, index) => {
    client.setQueryData(["conversations", project.id], [conversations[index]]);
    client.setQueryData(["agents", project.id], [agents[index]]);
    client.setQueryData(["agent-health", project.id], {
      scope: { type: "project", id: project.id },
      generatedAt: "2026-07-16T00:00:00.000Z",
      agents: [{ agentId: agents[index]!.id, childAgentIds: [], status: index === 0 ? "running" : "idle", statusTimestamp: "2026-07-16T00:00:00.000Z", reason: index === 0 ? "active_run" : "no_active_work" }],
    });
  });
  client.setQueryData(["triggers"], []);
  return client;
}

describe("responsive workspace sidebar flow", () => {
  it("renders duplicate Agent names as distinct, accessible global destinations", () => {
    const client = clientWithWorkspace();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects}
      preferences={preferences}
      route={{ kind: "allAgents" }}
      notifications={[]}
      onNavigate={vi.fn()}
      onCreateProject={vi.fn()}
      onPreferences={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    /></QueryClientProvider>);

    expect(html).toContain('aria-label="Workspace navigation"');
    expect(html).toContain('data-sidebar-state="expanded"');
    expect(html).toContain('data-sidebar-panel="agents"');
    expect(html).toContain('aria-label="Search agents"');
    expect(html).toContain('aria-label="Open agent Reviewer in Website · /repos/alpha"');
    expect(html).toContain('aria-label="Open agent Reviewer in Website · /repos/beta"');
    expect(html).toContain("Website · /repos/alpha · codex");
    expect(html).toContain("Website · /repos/beta · codex");
    client.clear();
  });

  it("uses the same primary navigation semantics in drawer mode", () => {
    const client = clientWithWorkspace();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><WorkspaceSidebar
      projects={projects}
      preferences={preferences}
      route={{ kind: "projects" }}
      notifications={[]}
      drawer
      onNavigate={vi.fn()}
      onCreateProject={vi.fn()}
      onPreferences={vi.fn()}
      onRenameConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
    /></QueryClientProvider>);

    expect(html).toContain('aria-label="Primary navigation drawer"');
    expect(html).toContain('aria-label="Search projects"');
    expect(html).toContain('data-sidebar-panel="projects"');
    expect(html).toContain("New Project");
    client.clear();
  });
});
