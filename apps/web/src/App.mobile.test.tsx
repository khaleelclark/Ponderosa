import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentDto, ConversationDto, ProjectDto } from "@ponderosa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mobileCreationReturnRoute,
  MobileWorkspaceTabManager,
} from "./App.mobile";
import type { WorkspaceTabState } from "./workspaceTabs";

const { listAgents, listConversations } = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { listAgents, listConversations },
}));

const project: ProjectDto = {
  id: "project-1",
  label: "Mobile QA",
  hostPath: "/tmp/mobile-qa",
  createdAt: "2026-08-12T00:00:00.000Z",
  defaultEngine: "codex",
};

const agent: AgentDto = {
  id: "agent-1",
  projectId: project.id,
  conversationIds: [],
  title: "Live Agent",
  activeEngine: "codex",
  state: {},
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
};

const conversation: ConversationDto = {
  id: "conversation-1",
  projectId: project.id,
  title: "Project Chat",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  archived: false,
};

const tabs: WorkspaceTabState[] = [
  {
    key: "tab-home",
    route: { kind: "home" },
    lastActivatedAt: 1,
  },
  {
    key: "tab-agent",
    route: { kind: "agent", projectId: project.id, agentId: agent.id },
    lastActivatedAt: 2,
  },
];

function renderManager(
  overrides: Partial<React.ComponentProps<typeof MobileWorkspaceTabManager>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props = {
    open: true,
    tabs,
    projects: [project],
    activeKey: "tab-agent",
    onClose: vi.fn(),
    onActivate: vi.fn(),
    onCloseTab: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <MobileWorkspaceTabManager {...props} />
    </QueryClientProvider>,
  );
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("mobile workspace tab management", () => {
  it("resolves saved tab labels and supports activation and closing", async () => {
    listAgents.mockResolvedValue([agent]);
    listConversations.mockResolvedValue([]);
    const props = renderManager();

    await waitFor(() => expect(screen.getByText("Live Agent")).toBeTruthy());
    expect(screen.getByText("Mobile QA · Current tab")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Home" }));
    expect(props.onCloseTab).toHaveBeenCalledWith("tab-home");

    const liveAgentLabel = screen.getByText("Live Agent");
    const liveAgentTab = liveAgentLabel.closest("[role=button]");
    expect(liveAgentTab).not.toBeNull();
    fireEvent.click(liveAgentTab!);
    expect(props.onActivate).toHaveBeenCalledWith("tab-agent");
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("loads only conversations for projects represented by chat tabs", async () => {
    listAgents.mockResolvedValue([]);
    listConversations.mockResolvedValue([conversation]);
    renderManager({
      tabs: [{
        key: "tab-chat",
        route: {
          kind: "conversation",
          projectId: project.id,
          conversationId: conversation.id,
        },
        lastActivatedAt: 1,
      }],
      activeKey: "tab-chat",
    });

    await waitFor(() => expect(screen.getByText("Project Chat")).toBeTruthy());
    expect(listConversations).toHaveBeenCalledTimes(1);
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("does not offer closing the final workspace tab", () => {
    listAgents.mockResolvedValue([]);
    listConversations.mockResolvedValue([]);
    renderManager({ tabs: [tabs[0]!], activeKey: "tab-home" });

    expect(screen.queryByRole("button", { name: "Close Home" })).toBeNull();
  });

  it("keeps interleaved creation origins isolated by persisted tab", () => {
    const origins = new Map([
      ["tab-a", { kind: "projects" } as const],
      ["tab-b", { kind: "allAgents" } as const],
    ]);

    expect(mobileCreationReturnRoute(origins, "tab-a")).toEqual({
      kind: "projects",
    });
    expect(mobileCreationReturnRoute(origins, "tab-b")).toEqual({
      kind: "allAgents",
    });
    expect(mobileCreationReturnRoute(origins, "missing")).toEqual({
      kind: "home",
    });
  });
});
