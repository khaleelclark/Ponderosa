import type {
  AgentDto,
  ConversationDto,
  TriggerDefinitionDto,
} from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { TriggersPane } from "../src/components/TriggersPane";
import { queryKeys } from "../src/queryKeys";

const projectId = "trigger-project";
const primaryConversationId = "primary-chat";
const unavailableConversationId = "unavailable-chat";
const createdAt = "2026-08-02T12:00:00.000Z";
const agent: AgentDto = {
  id: "trigger-agent",
  projectId,
  conversationId: primaryConversationId,
  conversationIds: [primaryConversationId],
  title: "Trigger Agent",
  activeEngine: "codex",
  state: {},
  createdAt,
  updatedAt: createdAt,
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
};
const trigger: TriggerDefinitionDto = {
  id: "trigger-one",
  projectId,
  conversationId: unavailableConversationId,
  agentId: agent.id,
  name: "QA Trigger",
  instructions: "Inspect the Project safely.",
  sourceKind: "schedule",
  sourceConfig: {
    scheduleKind: "interval",
    everyMs: 60_000,
    startsAt: createdAt,
  },
  enabled: true,
  fullAccess: true,
  createdAt,
  updatedAt: createdAt,
};
const primaryConversation: ConversationDto = {
  id: primaryConversationId,
  projectId,
  title: "Primary Chat",
  defaultEngine: "codex",
  createdAt,
  updatedAt: createdAt,
  archived: false,
};

function testClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.triggers.agent(agent.id), [trigger]);
  client.setQueryData(queryKeys.triggers.agentOccurrences(agent.id), []);
  return client;
}

function renderPane(client: QueryClient): void {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<TriggersPane agent={agent} />, { wrapper });
}

async function openTriggerEditor(): Promise<void> {
  await userEvent.setup().click(
    await screen.findByRole("button", { name: "Edit QA Trigger" }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Trigger editor Project chat identity", () => {
  it.each([
    {
      name: "is absent",
      conversations: [primaryConversation],
      expected: "Unavailable Chat",
    },
    {
      name: "was deleted",
      conversations: [
        primaryConversation,
        {
          ...primaryConversation,
          id: unavailableConversationId,
          title: "Deleted Chat",
          deletedAt: "2026-08-02T12:30:00.000Z",
        },
      ],
      expected: "Unavailable Chat",
    },
  ])("keeps the Trigger Chat identity when it $name", async ({
    conversations,
    expected,
  }) => {
    const client = testClient();
    client.setQueryData(
      queryKeys.conversations.project(projectId),
      conversations,
    );
    renderPane(client);
    await openTriggerEditor();

    expect(
      (await screen.findByDisplayValue(expected)).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByDisplayValue("Primary · Primary Chat")).toBeNull();
  });

  it("keeps the Trigger Chat identity while Chat names are loading", async () => {
    vi.spyOn(api, "listConversations").mockImplementation(
      () => new Promise<ConversationDto[]>(() => undefined),
    );
    renderPane(testClient());
    await openTriggerEditor();

    expect(
      (await screen.findByDisplayValue("Loading Chat…")).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the Trigger Chat identity when Chat names fail to load", async () => {
    vi.spyOn(api, "listConversations").mockRejectedValue(
      new Error("conversation query failed"),
    );
    renderPane(testClient());
    await openTriggerEditor();

    expect(
      (
        await screen.findByDisplayValue("Chat name unavailable")
      ).hasAttribute("disabled"),
    ).toBe(true);
  });
});
