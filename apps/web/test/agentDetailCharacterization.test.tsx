import {
  DEFAULT_ASSET_LIMITS,
  type AgentDetailDto,
  type AgentDto,
  type AgentHealthDto,
  type EngineDto,
  type WorkspacePreferencesDto,
} from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { chatStateKey } from "../src/chatState";
import { AgentDetail } from "../src/components/AgentDetail";
import { queryKeys } from "../src/queryKeys";

const now = "2026-07-26T12:00:00.000Z";
const projectId = "project-characterization";
const conversationId = "conversation-characterization";

const engine: EngineDto = {
  id: "codex",
  displayName: "Codex",
  models: [],
  efforts: [],
  configured: true,
  authenticated: true,
  available: true,
};

const preferences = {
  projectSort: "last_used",
  projectOrder: [],
  starredProjectIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 320,
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
  maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: true,
  contextRolloverTokens: 160_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: now,
  profile: {
    displayName: "Operator",
    handle: "operator",
    avatarId: "default-user",
  },
  updatedAt: now,
} satisfies WorkspacePreferencesDto;

function agent(id: string): AgentDto {
  return {
    id,
    projectId,
    conversationId,
    conversationIds: [conversationId],
    title: id === "agent-a" ? "Agent Alpha" : "Agent Beta",
    activeEngine: "codex",
    state: {},
    createdAt: now,
    updatedAt: now,
    archived: false,
    managementPermissions: {
      allowAutomaticDescendantDeletion: false,
      allowAutomaticDescendantReorganization: false,
    },
  };
}

function detail(id: string): AgentDetailDto {
  return {
    agent: agent(id),
    messages: [],
    runOutput: [],
    activity: [],
    changedFiles: [],
    runs: [],
    workItems: [],
    artifacts: [],
    state: {},
    history: { limit: 100, hasMore: false },
  };
}

function clientForAgents(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  for (const id of ["agent-a", "agent-b"]) {
    client.setQueryData(queryKeys.agents.detail(id, 100), detail(id));
    client.setQueryData(queryKeys.queuedMessages.agent(id), []);
  }
  client.setQueryData(queryKeys.notifications.all, []);
  client.setQueryData(queryKeys.workspacePreferences.all, preferences);
  client.setQueryData(queryKeys.projects.all, [
    {
      id: projectId,
      label: "Characterization",
      hostPath: "/tmp/characterization",
      defaultEngine: "codex",
      createdAt: now,
    },
  ]);
  client.setQueryData(queryKeys.assetLimits.all, DEFAULT_ASSET_LIMITS);
  return client;
}

function propsFor(
  agentId: string,
  overrides: Partial<ComponentProps<typeof AgentDetail>> = {},
): ComponentProps<typeof AgentDetail> {
  return {
    agentId,
    onOpenTechnicalDetails: vi.fn(),
    engines: [engine],
    engineCapabilities: [
      {
        engineId: "codex",
        steering: true,
        persistentSessions: true,
        commands: [],
        mcpServers: [],
        composerCapabilities: [],
      },
    ],
    onRefreshCapabilities: vi.fn(),
    statusByAgentId: new Map(),
    healthByAgentId: new Map(),
    agents: [agent("agent-a"), agent("agent-b")],
    conversations: [
      {
        id: conversationId,
        projectId,
        title: "Characterization chat",
        createdAt: now,
        updatedAt: now,
        archived: false,
      },
    ],
    onOpenProject: vi.fn(),
    onOpenAgent: vi.fn(),
    onOpenBroadcast: vi.fn(),
    onOpenMaster: vi.fn(),
    onOpenArtifact: vi.fn(),
    onOpenArtifactInNewTab: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenReviewInNewTab: vi.fn(),
    onOpenBrowser: vi.fn(),
    onNewSubagent: vi.fn(),
    onDeleted: vi.fn(),
    ...overrides,
  };
}

function tree(
  client: QueryClient,
  props: ComponentProps<typeof AgentDetail>,
): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <AgentDetail {...props} />
    </QueryClientProvider>
  );
}

function stubPublicApi(): Map<string, ReturnType<typeof vi.fn>> {
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  vi.spyOn(api, "subscribeAgent").mockImplementation(agentId => {
    const close = vi.fn();
    closes.set(agentId, close);
    return { close };
  });
  vi.spyOn(api, "getConversationDraft").mockImplementation(
    async (draftId, ownerId) => ({
      conversationId: draftId,
      ownerId,
      text: "",
      attachmentIds: [],
      revision: 0,
      updatedAt: now,
      clientId: "server",
    }),
  );
  return closes;
}

function runningHealth(
  agentId: string,
  startedAt: string,
): AgentHealthDto {
  return {
    agentId,
    childAgentIds: [],
    status: "running",
    statusTimestamp: now,
    reason: "active_run",
    executionId: `run-${agentId}`,
    runtimeOwnership: "running",
    runtimeActivity: {
      state: "responding",
      executionId: `run-${agentId}`,
      startedAt,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("AgentDetail public behavior", () => {
  it("restarts only the effects whose public dependencies change and closes them", async () => {
    const closes = stubPublicApi();
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    const client = clientForAgents();
    const firstStart = "2026-07-26T11:59:50.000Z";
    const secondStart = "2026-07-26T11:59:55.000Z";
    const firstProps = propsFor("agent-a", {
      projectedHealth: runningHealth("agent-a", firstStart),
    });
    const view = render(tree(client, firstProps));

    await screen.findByRole("heading", { name: "Agent Alpha" });
    expect(api.subscribeAgent).toHaveBeenCalledTimes(1);
    expect(api.subscribeAgent).toHaveBeenLastCalledWith(
      "agent-a",
      undefined,
      expect.any(Object),
    );
    const firstTimerCall = setInterval.mock.calls.findIndex(
      call => call[1] === 1_000,
    );
    expect(firstTimerCall).toBeGreaterThanOrEqual(0);
    const firstTimer = setInterval.mock.results[firstTimerCall]!.value;

    view.rerender(
      tree(client, {
        ...firstProps,
        onOpenProject: vi.fn(),
      }),
    );
    expect(api.subscribeAgent).toHaveBeenCalledTimes(1);
    expect(
      setInterval.mock.calls.filter(call => call[1] === 1_000),
    ).toHaveLength(1);

    view.rerender(
      tree(client, {
        ...firstProps,
        projectedHealth: runningHealth("agent-a", secondStart),
      }),
    );
    await waitFor(() => expect(clearInterval).toHaveBeenCalledWith(firstTimer));
    expect(
      setInterval.mock.calls.filter(call => call[1] === 1_000),
    ).toHaveLength(2);

    view.rerender(
      tree(
        client,
        propsFor("agent-b", {
          projectedHealth: runningHealth("agent-b", secondStart),
        }),
      ),
    );
    await screen.findByRole("heading", { name: "Agent Beta" });
    expect(closes.get("agent-a")).toHaveBeenCalledTimes(1);
    expect(api.subscribeAgent).toHaveBeenCalledTimes(2);
    expect(api.subscribeAgent).toHaveBeenLastCalledWith(
      "agent-b",
      undefined,
      expect.any(Object),
    );

    view.unmount();
    expect(closes.get("agent-b")).toHaveBeenCalledTimes(1);
    const latestTimerCall = setInterval.mock.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[1] === 1_000)
      .at(-1)!.index;
    expect(clearInterval).toHaveBeenCalledWith(
      setInterval.mock.results[latestTimerCall]!.value,
    );
    client.clear();
  });

  it("preserves active-Agent UI state across rerenders and resets it for a new Agent", async () => {
    stubPublicApi();
    window.localStorage.setItem(
      chatStateKey("view", "agent.agent-b"),
      "settings",
    );
    const client = clientForAgents();
    const onViewChange = vi.fn();
    const firstProps = propsFor("agent-a", { onViewChange });
    const view = render(tree(client, firstProps));
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Agent Alpha" });
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(onViewChange).toHaveBeenCalledWith("activity");
    expect(
      screen.getByRole("tabpanel", { name: "Activity panel" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Activity" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");

    view.rerender(
      tree(client, {
        ...firstProps,
        onOpenProject: vi.fn(),
      }),
    );
    expect(
      screen.getByRole("tabpanel", { name: "Activity panel" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Activity" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");

    view.rerender(tree(client, propsFor("agent-b")));
    await screen.findByRole("heading", { name: "Agent Beta" });
    await screen.findByLabelText("Agent settings");
    expect(
      screen.getByRole("tab", { name: "Settings" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");

    view.unmount();
    client.clear();
  });
});
