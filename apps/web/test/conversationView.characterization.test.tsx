import type {
  AgentDto,
  AgentHealthDto,
  ArtifactDto,
  ConversationDetailDto,
  ConversationDto,
  ConversationMessageDto,
  EngineDto,
  ProjectDto,
  QueuedConversationMessageDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { chatStateKey } from "../src/chatState";
import { ConversationView } from "../src/components/ConversationView";
import { queryKeys } from "../src/queryKeys";

const projectId = "project-characterization";
const firstConversationId = "conversation-one";
const secondConversationId = "conversation-two";
const engineId = "codex";
const createdAt = "2026-07-25T10:00:00.000Z";
// A focused message is scrolled either by Element.scrollIntoView or, when it
// sits inside a .chat-scroll-region, by scrolling that container directly so
// overflow-hidden workspace ancestors stay put. jsdom implements neither, so
// both routes report through one spy and these assertions characterize "the
// focused message was scrolled once" rather than which strategy was chosen.
const scrollFocusedMessage = vi.fn();

const agent: AgentDto = {
  id: "agent-one",
  projectId,
  conversationId: firstConversationId,
  conversationIds: [firstConversationId, secondConversationId],
  title: "Agent One",
  activeEngine: engineId,
  state: {},
  createdAt,
  updatedAt: createdAt,
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
};

const engines: EngineDto[] = [
  {
    id: engineId,
    displayName: "Codex",
    models: [],
    efforts: [],
    configured: true,
    authenticated: true,
    available: true,
  },
];

const project: ProjectDto = {
  id: projectId,
  label: "Characterization",
  hostPath: "/tmp/characterization",
  defaultEngine: engineId,
  createdAt,
};

const preferences: WorkspacePreferencesDto = {
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
  engineDefaults: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: true,
  contextRolloverTokens: 120_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: createdAt,
  profile: {
    displayName: "Operator",
    handle: "operator",
    avatarId: "default-user",
  },
  updatedAt: createdAt,
};

function conversation(id: string, title: string): ConversationDto {
  return {
    id,
    projectId,
    title,
    defaultEngine: engineId,
    createdAt,
    updatedAt: createdAt,
    archived: false,
  };
}

function message({
  id,
  conversationId = firstConversationId,
  text,
  at,
  communicationEventId,
}: {
  id: string;
  conversationId?: string;
  text: string;
  at: string;
  communicationEventId?: string;
}): ConversationMessageDto {
  return {
    id,
    communicationEventId,
    conversationId,
    role: "assistant",
    text,
    createdAt: at,
    authorAgentId: agent.id,
  };
}

const firstMessage = message({
  id: "message-one",
  text: "First actual response",
  at: "2026-07-25T10:01:00.000Z",
  communicationEventId: "communication-one",
});
const secondMessage = message({
  id: "message-two",
  text: "Second actual response",
  at: "2026-07-25T10:02:00.000Z",
});

const chatArtifact: ArtifactDto = {
  id: "artifact-one",
  projectId,
  agentId: agent.id,
  originAgentId: agent.id,
  kind: "document",
  path: "results/brief.md",
  summary: "Project brief",
  createdAt: "2026-07-25T10:04:00.000Z",
  mediaType: "text/markdown",
  previewUrl: "/api/artifacts/artifact-one/preview",
  downloadUrl: "/api/artifacts/artifact-one/download",
};

function detail(
  conversationValue: ConversationDto,
  messages: ConversationMessageDto[],
): ConversationDetailDto {
  return {
    conversation: conversationValue,
    messages,
    agents: [agent],
    decisionEvents: [],
    history: { hasMore: false },
  };
}

function createClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(
    queryKeys.conversations.detail(firstConversationId),
    detail(
      conversation(firstConversationId, "First conversation"),
      [firstMessage, secondMessage],
    ),
  );
  client.setQueryData(
    queryKeys.conversations.detail(secondConversationId),
    detail(conversation(secondConversationId, "Second conversation"), [
      message({
        id: "message-three",
        conversationId: secondConversationId,
        text: "Second conversation response",
        at: "2026-07-25T10:03:00.000Z",
      }),
    ]),
  );
  for (const id of [firstConversationId, secondConversationId]) {
    client.setQueryData(queryKeys.collaboration(id), {
      messages: [],
      agents: [agent],
      operations: [],
      history: { hasMore: false },
      operationHistory: { hasMore: false },
    });
    client.setQueryData(queryKeys.queuedMessages.conversation(id), []);
    client.setQueryData(
      queryKeys.projectArtifacts.conversation(projectId, id),
      {
        items: id === firstConversationId ? [chatArtifact] : [],
        history: { limit: 100, hasMore: false },
      },
    );
  }
  client.setQueryData(queryKeys.notifications.all, []);
  client.setQueryData(queryKeys.workspacePreferences.all, preferences);
  client.setQueryData(queryKeys.projects.all, [project]);
  client.setQueryData(queryKeys.projectBrowser.project(projectId), {
    status: "inactive",
  });
  return client;
}

function props(conversationId = firstConversationId) {
  return {
    conversationId,
    engines,
    engineCapabilities: [],
    onRefreshCapabilities: vi.fn(),
    statusByAgentId: new Map(),
    healthByAgentId: new Map(),
    projectAgents: [agent],
    onOpenProject: vi.fn(),
    onOpenAgent: vi.fn(),
    onOpenAgentInNewTab: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenAgentWork: vi.fn(),
    onOpenBrowser: vi.fn(),
    onOpenFileActivity: vi.fn(),
    onNewAgent: vi.fn(),
    onDeleted: vi.fn(),
  };
}

function view(
  client: QueryClient,
  element: ReactElement,
): ReactElement {
  return <QueryClientProvider client={client}>{element}</QueryClientProvider>;
}

class ObservableIntersectionObserver implements IntersectionObserver {
  static instances: ObservableIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0.5];
  observed?: Element;
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
  ) {
    ObservableIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed = target;
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  intersect(): void {
    if (!this.observed) throw new Error("observer has no target");
    this.callback(
      [
        {
          boundingClientRect: this.observed.getBoundingClientRect(),
          intersectionRatio: 1,
          intersectionRect: this.observed.getBoundingClientRect(),
          isIntersecting: true,
          rootBounds: null,
          target: this.observed,
          time: 0,
        },
      ],
      this,
    );
  }
}

beforeEach(() => {
  localStorage.clear();
  scrollFocusedMessage.mockClear();
  ObservableIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ObservableIntersectionObserver);
  for (const method of ["scrollIntoView", "scrollTo"] as const) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: scrollFocusedMessage,
    });
  }
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConversationView public behavior", () => {
  it("keeps responding-time updates outside the Project Chat content viewport", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:59.000Z"));
    const client = createClient();
    const health: AgentHealthDto = {
      agentId: agent.id,
      childAgentIds: [],
      status: "running",
      statusTimestamp: "2026-08-02T00:00:59.000Z",
      reason: "active_run",
      executionId: "run-responding",
      runtimeOwnership: "running",
      runtimeActivity: {
        state: "responding",
        executionId: "run-responding",
        startedAt: "2026-08-02T00:00:00.000Z",
      },
    };
    render(view(client, <ConversationView
      {...props()}
      healthByAgentId={new Map([[agent.id, health]])}
    />));

    const viewport = document.querySelector<HTMLElement>(
      ".chat-scroll-region[aria-label='Project chat messages']",
    )!;
    const content = viewport.querySelector("[data-chat-content='true']");
    const status = screen.getByRole("status");
    expect(content?.contains(status)).toBe(false);
    expect(status.textContent).toContain("0:59");

    viewport.scrollTop = 127;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status").textContent).toContain("1:00");
    expect(viewport.scrollTop).toBe(127);

    client.clear();
  });

  it("reconciles queued and canonical messages monotonically across stale refetches", async () => {
    const client = createClient();
    const queuedMessage: QueuedConversationMessageDto = {
      deliveryId: "activation-queued-message",
      messageId: "communication-queued-message",
      conversationId: firstConversationId,
      targetAgentId: agent.id,
      text: "Keep this message stable",
      position: 1,
      createdAt: "2026-07-25T10:05:00.000Z",
      status: "queued",
    };
    const canonicalMessage: ConversationMessageDto = {
      id: "message-queued-message",
      communicationEventId: queuedMessage.messageId,
      communicationIntent: "user_dm",
      directMessageAgents: [{ id: agent.id, title: agent.title }],
      conversationId: firstConversationId,
      role: "user",
      text: queuedMessage.text,
      createdAt: queuedMessage.createdAt,
      deliveryReceipts: [{
        activationId: queuedMessage.deliveryId,
        targetAgentId: agent.id,
        state: "queued",
        updatedAt: queuedMessage.createdAt,
        attemptCount: 0,
      }],
    };

    client.setQueryData<ConversationDetailDto>(
      queryKeys.conversations.detail(firstConversationId),
      detail(conversation(firstConversationId, "First conversation"), []),
    );
    client.setQueryData(
      queryKeys.queuedMessages.conversation(firstConversationId),
      [queuedMessage],
    );
    render(view(client, <ConversationView {...props()} />));

    expect(screen.getAllByText(queuedMessage.text)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit queued message 1" }))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete queued message 1" }))
      .toBeTruthy();

    act(() => {
      client.setQueryData<ConversationDetailDto>(
        queryKeys.conversations.detail(firstConversationId),
        detail(
          conversation(firstConversationId, "First conversation"),
          [canonicalMessage],
        ),
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText(queuedMessage.text)).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Edit queued message 1" }))
        .toBeTruthy();
    });

    const startedMessage: ConversationMessageDto = {
      ...canonicalMessage,
      deliveryReceipts: canonicalMessage.deliveryReceipts?.map(receipt => ({
        ...receipt,
        state: "started",
        updatedAt: "2026-07-25T10:06:00.000Z",
      })),
    };
    act(() => {
      client.setQueryData<ConversationDetailDto>(
        queryKeys.conversations.detail(firstConversationId),
        detail(
          conversation(firstConversationId, "First conversation"),
          [startedMessage],
        ),
      );
      client.setQueryData(
        queryKeys.queuedMessages.conversation(firstConversationId),
        [],
      );
    });
    await waitFor(() => {
      expect(screen.getAllByText(queuedMessage.text)).toHaveLength(1);
      expect(screen.queryByLabelText("Queued messages")).toBeNull();
    });

    for (const position of [1, 2]) {
      act(() => {
        client.setQueryData(
          queryKeys.queuedMessages.conversation(firstConversationId),
          [{ ...queuedMessage, position }],
        );
      });
      await waitFor(() => {
        expect(screen.getAllByText(queuedMessage.text)).toHaveLength(1);
        expect(screen.queryByLabelText("Queued messages")).toBeNull();
      });
    }

    client.clear();
  });

  it("renders actual messages and preserves message-local state across keyed reordering", async () => {
    const client = createClient();
    const user = userEvent.setup();
    render(view(client, <ConversationView {...props()} />));

    expect(screen.getByText("First actual response")).toBeTruthy();
    expect(screen.getByText("Second actual response")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();

    const secondArticle = document.getElementById("master-message-message-two");
    expect(secondArticle).toBeTruthy();
    await user.click(
      within(secondArticle!).getByRole("button", {
        name: "Copy whole message",
      }),
    );
    expect(await within(secondArticle!).findByText("Message copied")).toBeTruthy();

    act(() => {
      client.setQueryData<ConversationDetailDto>(
        queryKeys.conversations.detail(firstConversationId),
        current => ({
          ...current!,
          messages: current!.messages.map(item =>
            item.id === firstMessage.id
              ? { ...item, createdAt: "2026-07-25T10:04:00.000Z" }
              : item,
          ),
        }),
      );
    });

    await waitFor(() => {
      const articles = [
        ...document.querySelectorAll<HTMLElement>(
          "#master-message-message-one, #master-message-message-two",
        ),
      ];
      expect(articles.map(item => item.id)).toEqual([
        "master-message-message-two",
        "master-message-message-one",
      ]);
    });
    expect(
      within(document.getElementById("master-message-message-two")!).getByText(
        "Message copied",
      ),
    ).toBeTruthy();
    expect(
      within(document.getElementById("master-message-message-one")!).queryByText(
        "Message copied",
      ),
    ).toBeNull();

    client.clear();
  });

  it("highlights Direct participants in messages and keeps one Broadcast badge", () => {
    const client = createClient();
    client.setQueryData<ConversationDetailDto>(
      queryKeys.conversations.detail(firstConversationId),
      detail(conversation(firstConversationId, "First conversation"), [
        {
          id: "direct-message",
          communicationEventId: "direct-communication",
          communicationIntent: "user_dm",
          directMessageAgents: [{ id: agent.id, title: agent.title }],
          conversationId: firstConversationId,
          role: "user",
          text: "#Agent-One Private hello",
          createdAt: "2026-07-25T10:01:00.000Z",
          agentMentions: [{ agentId: agent.id, handle: "Agent-One" }],
        },
        {
          id: "broadcast-message",
          communicationEventId: "broadcast-communication",
          communicationIntent: "broadcast",
          conversationId: firstConversationId,
          role: "user",
          text: "#broadcast Shared update",
          createdAt: "2026-07-25T10:02:00.000Z",
        },
        {
          id: "agent-direct-response",
          communicationEventId: "agent-direct-communication",
          communicationIntent: "user_dm",
          directMessageAgents: [{ id: agent.id, title: agent.title }],
          conversationId: firstConversationId,
          role: "assistant",
          authorAgentId: agent.id,
          text: "#user Agent private response",
          createdAt: "2026-07-25T10:03:00.000Z",
        },
      ]),
    );

    render(view(client, <ConversationView {...props()} />));

    const userDirect = document.getElementById("master-message-direct-message");
    expect(userDirect?.textContent).toContain("#Agent-One Private hello");
    expect(
      userDirect?.querySelector('[aria-label="Open agent Agent-One"]')
        ?.textContent,
    ).toBe("#Agent-One");
    const agentDirect = document.getElementById(
      "master-message-agent-direct-response",
    );
    expect(agentDirect?.textContent).toContain("#operator Agent private response");
    expect(
      agentDirect?.querySelector('[data-message-tag="user"]')?.textContent,
    ).toBe("#operator");
    expect(screen.getByText("Shared update")).toBeTruthy();
    expect(screen.queryByText("#broadcast Shared update")).toBeNull();
    expect(screen.queryByText(/Direct ·/u)).toBeNull();
    expect(screen.getByText("To: Agent One")).toBeTruthy();
    expect(screen.queryByText(
      "Sending without a recipient starts a new Agent.",
    )).toBeNull();
    expect(screen.getAllByText("Broadcast")).toHaveLength(1);
    expect(
      document
        .getElementById("master-message-broadcast-message")
        ?.querySelector(".chat-message-actions")
        ?.getAttribute("data-action-alignment"),
    ).toBe("end");

    client.clear();
  });

  it("preserves authored group Direct handles after rename and deletion", () => {
    const client = createClient();
    client.setQueryData<ConversationDetailDto>(
      queryKeys.conversations.detail(firstConversationId),
      detail(conversation(firstConversationId, "First conversation"), [{
        id: "group-direct-message",
        communicationEventId: "group-direct-communication",
        communicationIntent: "user_dm",
        directMessageAgents: [
          { id: agent.id, title: "Redwood" },
          { id: "agent-two", title: "Pine" },
        ],
        conversationId: firstConversationId,
        role: "user",
        text: "(#Oak), (#Pine) Private hello",
        createdAt: "2026-07-25T10:01:00.000Z",
        agentMentions: [
          { agentId: agent.id, handle: "Oak" },
          { agentId: "agent-two", handle: "Pine" },
        ],
      }]),
    );

    render(view(client, <ConversationView {...props()} />));

    const message = document.getElementById(
      "master-message-group-direct-message",
    );
    expect(message?.textContent).toContain("(#Oak), (#Pine) Private hello");
    expect(
      message?.querySelector('[aria-label="Open agent Oak"]')?.textContent,
    ).toBe("#Oak");
    expect(
      message?.querySelector('[aria-label="Open agent Pine"]')?.textContent,
    ).toBe("#Pine");
    expect(screen.queryByText(/^To:/u)).toBeNull();
    expect(screen.getByText(
      "Sending without a recipient starts a new Agent.",
    )).toBeTruthy();

    client.clear();
  });

  it("ties a fresh-Agent response to the composer without labeling its opening as Broadcast", async () => {
    const client = createClient();
    const user = userEvent.setup();
    client.setQueryData<ConversationDetailDto>(
      queryKeys.conversations.detail(firstConversationId),
      detail(conversation(firstConversationId, "First conversation"), [
        {
          id: "fresh-agent-opening",
          communicationEventId: `agent-opening:${agent.id}`,
          communicationIntent: "broadcast",
          conversationId: firstConversationId,
          role: "user",
          text: "Generate a pure white image",
          createdAt: "2026-07-25T10:01:00.000Z",
        },
        {
          id: "fresh-agent-response",
          communicationEventId: "fresh-agent-response-event",
          communicationIntent: "broadcast",
          conversationId: firstConversationId,
          role: "assistant",
          authorAgentId: agent.id,
          text: "#broadcast Here is the image.",
          createdAt: "2026-07-25T10:02:00.000Z",
        },
      ]),
    );

    render(view(client, <ConversationView {...props()} />));

    const opening = document.getElementById(
      "master-message-fresh-agent-opening",
    );
    expect(opening?.textContent).not.toContain("Broadcast");
    expect(screen.getByText("To: Agent One")).toBeTruthy();

    const selectedDestination = screen.getByRole("button", {
      name: "To: Agent One. Press Delete or Backspace to clear.",
    });
    selectedDestination.focus();
    await user.keyboard("{Backspace}");
    expect(screen.queryByText("To: Agent One")).toBeNull();
    expect(screen.getByText(
      "Sending without a recipient starts a new Agent.",
    )).toBeTruthy();

    client.clear();
  });

  it("keeps selected-view state on ordinary rerenders and resets it for a new conversation", async () => {
    const client = createClient();
    const user = userEvent.setup();
    const firstProps = props();
    const result = render(
      view(client, <ConversationView {...firstProps} />),
    );

    expect(
      document
        .querySelector(".chat-scroll-region[aria-label='Project chat messages']")
        ?.querySelector("[data-chat-content='true']"),
    ).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Team Chat" }));
    expect(
      screen.getByRole("tab", { name: "Team Chat" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("tabpanel", { name: "Team chat messages" }).hidden,
    ).toBe(false);
    expect(
      document
        .querySelector(".chat-scroll-region[aria-label='Team chat messages']")
        ?.querySelector("[data-chat-content='true']"),
    ).toBeTruthy();

    result.rerender(
      view(
        client,
        <ConversationView
          {...firstProps}
          healthByAgentId={new Map()}
        />,
      ),
    );
    expect(
      screen.getByRole("tab", { name: "Team Chat" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");

    localStorage.setItem(
      chatStateKey("view", `conversation.${secondConversationId}`),
      "main",
    );
    result.rerender(
      view(client, <ConversationView {...props(secondConversationId)} />),
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Second conversation" })).toBeTruthy();
      expect(
        screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(
      screen.getByRole("tabpanel", { name: "Project chat messages" }).hidden,
    ).toBe(false);

    client.clear();
  });

  it("shows and highlights the canonical destination on a Team Chat reply", async () => {
    const client = createClient();
    const recipient = { ...agent, id: "agent-two", title: "Redwood" };
    client.setQueryData(queryKeys.collaboration(firstConversationId), {
      messages: [{
        ...firstMessage,
        text: "#Oak The requested review is complete.",
        communicationIntent: "collaboration" as const,
        collaborationRecipients: [{ id: recipient.id, title: recipient.title }],
        agentMentions: [{ agentId: recipient.id, handle: "Oak" }],
      }],
      agents: [agent, recipient],
      operations: [],
      history: { hasMore: false },
      operationHistory: { hasMore: false },
    });
    const conversationDetail = client.getQueryData<ConversationDetailDto>(
      queryKeys.conversations.detail(firstConversationId),
    )!;
    client.setQueryData<ConversationDetailDto>(
      queryKeys.conversations.detail(firstConversationId),
      { ...conversationDetail, agents: [agent, recipient] },
    );
    const user = userEvent.setup();
    render(view(client, (
      <ConversationView {...props()} projectAgents={[agent, recipient]} />
    )));

    await user.click(screen.getByRole("tab", { name: "Team Chat" }));
    const teamPanel = screen.getByRole("tabpanel", {
      name: "Team chat messages",
    });
    expect(within(teamPanel).getByText("→ Redwood")).toBeTruthy();
    expect(
      within(teamPanel).getByRole("button", { name: "Open agent Oak" })
        .textContent,
    ).toBe("#Oak");
    expect(
      within(teamPanel).getByText("The requested review is complete."),
    ).toBeTruthy();

    client.clear();
  });

  it("shows Files & Results for every Agent in the Chat", async () => {
    const client = createClient();
    const user = userEvent.setup();
    render(view(client, <ConversationView {...props()} />));

    await user.click(screen.getByRole("tab", { name: "Files & Results" }));

    expect(
      screen.getByRole("tab", { name: "Files & Results" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Chat files and results" })).toBeTruthy();
    expect(screen.getByText("Project brief")).toBeTruthy();
    expect(screen.getByText(/1 item created by Agents in this Chat/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Write a message…")).toBeNull();

    client.clear();
  });

  it("runs the focus effect only for its dependencies and disposes each highlight", async () => {
    const client = createClient();
    const initialProps = props();
    const result = render(
      view(
        client,
        <ConversationView
          {...initialProps}
          focusMessageId={firstMessage.id}
        />,
      ),
    );
    const firstArticle = document.getElementById(
      "master-message-message-one",
    )!;

    await waitFor(() => {
      expect(firstArticle.dataset.notificationFocus).toBe("true");
      expect(scrollFocusedMessage).toHaveBeenCalledTimes(1);
    });

    result.rerender(
      view(
        client,
        <ConversationView
          {...initialProps}
          healthByAgentId={new Map()}
          focusMessageId={firstMessage.id}
        />,
      ),
    );
    expect(scrollFocusedMessage).toHaveBeenCalledTimes(1);
    expect(firstArticle.dataset.notificationFocus).toBe("true");

    result.rerender(
      view(
        client,
        <ConversationView
          {...initialProps}
          focusMessageId={secondMessage.id}
        />,
      ),
    );
    const secondArticle = document.getElementById(
      "master-message-message-two",
    )!;
    await waitFor(() => {
      expect(firstArticle.dataset.notificationFocus).toBeUndefined();
      expect(secondArticle.dataset.notificationFocus).toBe("true");
      expect(scrollFocusedMessage).toHaveBeenCalledTimes(2);
    });

    result.unmount();
    expect(secondArticle.dataset.notificationFocus).toBeUndefined();
    client.clear();
  });

  it("marks a visible message notification read and tears down its observer", async () => {
    const notification: WorkspaceNotificationDto = {
      id: "notification-one",
      projectId,
      conversationId: firstConversationId,
      agentId: agent.id,
      communicationEventId: firstMessage.communicationEventId,
      kind: "project_responses",
      title: "New response",
      body: "Agent One responded",
      createdAt,
    };
    const client = createClient();
    client.setQueryData(queryKeys.notifications.all, [notification]);
    const markRead = vi
      .spyOn(api, "markNotificationRead")
      .mockResolvedValue(undefined);
    vi.spyOn(api, "listNotifications").mockResolvedValue([
      { ...notification, readAt: createdAt },
    ]);

    const result = render(view(client, <ConversationView {...props()} />));
    const observer = ObservableIntersectionObserver.instances.find(
      item => item.observed?.id === "master-message-message-one",
    );
    expect(observer).toBeTruthy();

    act(() => observer!.intersect());
    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith(notification.id);
    });
    expect(
      client.getQueryData<WorkspaceNotificationDto[]>(
        queryKeys.notifications.all,
      )?.[0]?.readAt,
    ).toBeTruthy();

    result.unmount();
    expect(observer!.disconnected).toBe(true);
    client.clear();
  });
});
