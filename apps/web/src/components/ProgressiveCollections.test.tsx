import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentDto,
  ConversationDto,
  ProjectDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsTab } from "./AgentsTab";
import { ProjectOverview } from "./ProjectOverview";

vi.mock("../api", () => ({
  api: {
    getAgentWork: vi.fn().mockResolvedValue({ traces: [] }),
    listDecisions: vi.fn().mockResolvedValue([]),
  },
}));

afterEach(cleanup);

function renderWithQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function syntheticAgent(index: number): AgentDto {
  return {
    id: `agent-${index}`,
    projectId: "project-1",
    conversationIds: [],
    title: `Agent ${String(index).padStart(3, "0")}`,
    activeEngine: "codex",
    state: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    managementPermissions: {
      allowAutomaticDescendantDeletion: false,
      allowAutomaticDescendantReorganization: false,
    },
  };
}

function syntheticConversation(index: number): ConversationDto {
  return {
    id: `chat-${index}`,
    projectId: "project-1",
    title: `Chat ${String(index).padStart(3, "0")}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
  };
}

const project: ProjectDto = {
  id: "project-1",
  label: "Synthetic Project",
  hostPath: "/tmp/synthetic-project",
  createdAt: "2026-01-01T00:00:00.000Z",
  defaultEngine: "codex",
};

const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  chatSort: "alphabetical",
  chatOrder: [],
  starredProjectIds: [],
  starredResourceIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 280,
  notifications: {
    mentions: true,
    directReplies: true,
    projectChatMessages: true,
    broadcasts: true,
    allMessages: false,
  },
  fontFamily: "inter",
  providerAvailability: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 4,
  contextRolloverEnabled: true,
  contextRolloverTokens: 100_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: null,
  profile: { displayName: "Tester", handle: "tester", avatarId: "" },
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies WorkspacePreferencesDto;

describe("large collection progressive rendering", () => {
  it("bounds a 500-Agent roster while full search and selection remain available", async () => {
    const agents = Array.from({ length: 500 }, (_, index) => syntheticAgent(index));
    const onOpenAgent = vi.fn();
    renderWithQueryClient(
      <AgentsTab
        agents={agents}
        projectId={project.id}
        engines={[]}
        conversations={[]}
        statusByAgentId={new Map()}
        healthByAgentId={new Map()}
        onOpenAgent={onOpenAgent}
        onNewAgent={() => undefined}
        progressiveBatchSize={25}
        collection={{
          title: "Project Agents",
          totalCount: agents.length,
          variant: "embedded",
        }}
      />,
    );

    expect(screen.getAllByRole("treeitem")).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: /Show 25 more Agents/ }));
    expect(screen.getAllByRole("treeitem")).toHaveLength(50);

    fireEvent.change(screen.getByRole("textbox", { name: "Search Agents" }), {
      target: { value: "Agent 499" },
    });
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Select Agents" }));
    expect(screen.getByRole("checkbox", { name: "Select Agent 499" })).toBeTruthy();
    fireEvent.click(screen.getByText("Agent 499"));
    expect(
      (screen.getByRole("checkbox", {
        name: "Select Agent 499",
      }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("bounds 500 Project Chats while deep search and opening remain complete", async () => {
    const conversations = Array.from(
      { length: 500 },
      (_, index) => syntheticConversation(index),
    );
    const onOpenConversation = vi.fn();
    renderWithQueryClient(
      <ProjectOverview
        project={project}
        agents={[]}
        healthByAgentId={new Map()}
        importantArtifacts={[]}
        conversations={conversations}
        notifications={[]}
        preferences={preferences}
        onPreferences={() => undefined}
        onCreateConversation={() => undefined}
        onOpenConversation={onOpenConversation}
        onRenameConversation={() => undefined}
        onDeleteConversation={() => undefined}
        onOpenAgentWork={() => undefined}
        onOpenProjectFiles={() => undefined}
        onOpenImportantArtifact={() => undefined}
      />,
    );

    expect(screen.getAllByRole("button", { name: /^Open Chat / })).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: /Show 25 more Chats/ }));
    expect(screen.getAllByRole("button", { name: /^Open Chat / })).toHaveLength(50);

    fireEvent.change(screen.getByRole("textbox", { name: "Search Project Chats" }), {
      target: { value: "Chat 499" },
    });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Open Chat / })).toHaveLength(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Chat Chat 499" }));
    expect(onOpenConversation).toHaveBeenCalledWith("chat-499");
  });

  it("renders secondary-Chat membership using stable relationship context", () => {
    const manager = {
      ...syntheticAgent(1),
      title: "Project Manager",
      conversationId: "chat-primary",
      conversationIds: ["chat-primary"],
    };
    const child = {
      ...syntheticAgent(2),
      title: "Secondary Member",
      managerAgentId: manager.id,
      conversationId: "chat-primary",
      conversationIds: ["chat-primary", "chat-secondary"],
    };
    const secondary = {
      ...syntheticConversation(2),
      id: "chat-secondary",
      title: "Secondary Chat",
    };
    renderWithQueryClient(
      <AgentsTab
        agents={[child]}
        relationshipAgents={[manager, child]}
        projectId={project.id}
        engines={[]}
        conversations={[secondary]}
        scopeConversationId={secondary.id}
        statusByAgentId={new Map()}
        healthByAgentId={new Map()}
        onOpenAgent={() => undefined}
        onNewAgent={() => undefined}
      />,
    );

    expect(screen.getByText("Delegated under Project Manager")).toBeTruthy();
    expect(screen.getByText("Secondary Chat")).toBeTruthy();
    expect(screen.queryByText("Unlinked Agent")).toBeNull();
    expect(screen.queryByText("Unknown Project Chat")).toBeNull();
  });
});
