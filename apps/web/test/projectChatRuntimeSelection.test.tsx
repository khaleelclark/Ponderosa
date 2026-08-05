import type { AgentDto, ConversationDto, EngineDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { useConversationMessagingController } from "../src/components/useConversationMessagingController";
import { queryKeys } from "../src/queryKeys";

const conversationId = "runtime-selection-conversation";
const projectId = "runtime-selection-project";
const createdAt = "2026-08-05T12:00:00.000Z";
const conversation: ConversationDto = {
  id: conversationId,
  projectId,
  title: "Runtime selection",
  defaultEngine: "claude",
  createdAt,
  updatedAt: createdAt,
  archived: false,
};
const agent: AgentDto = {
  id: "runtime-selection-agent",
  projectId,
  conversationId,
  conversationIds: [conversationId],
  title: "Timber",
  activeEngine: "claude",
  state: {},
  createdAt,
  updatedAt: createdAt,
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
};
const engine: EngineDto = {
  id: "claude",
  displayName: "Claude",
  configured: true,
  authenticated: true,
  available: true,
  models: [{
    id: "opus",
    label: "Opus",
    efforts: [{ id: "high", label: "High" }],
    serviceTiers: [{ id: "priority", label: "Priority" }],
  }],
  efforts: [{ id: "high", label: "High" }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Project Chat runtime selection", () => {
  it("sends the selected runtime configuration to an existing Agent", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(
      queryKeys.queuedMessages.conversation(conversationId),
      [],
    );
    vi.spyOn(api, "listQueuedConversationMessages").mockResolvedValue([]);
    const send = vi.spyOn(api, "sendMultiAgentDirectMessage").mockResolvedValue({
      messageId: "message-1",
      replayed: false,
      recipients: [{
        agentId: agent.id,
        queued: true,
        deliveryId: "delivery-1",
        state: "queued",
      }],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useConversationMessagingController({
        conversationId,
        conversation,
        agents: [agent],
        detailAgents: [agent],
        engines: [engine],
        engine: engine.id,
        model: "opus",
        effort: "high",
        speed: "priority",
        statusByAgentId: new Map(),
        healthByAgentId: new Map(),
        agentTitle: () => agent.title,
      }),
      { wrapper },
    );

    await act(async () => {
      await result.current.submit(
        "How about now?",
        [],
        "queue",
        [],
        undefined,
        agent.id,
      );
    });

    expect(send).toHaveBeenCalledWith(conversationId, expect.objectContaining({
      model: "opus",
      effort: "high",
      speed: "priority",
      activeRunDelivery: "queue",
    }));
  });
});
