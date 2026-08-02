import type { AgentDto, ConversationDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ApiRequestError } from "../src/api/types";
import { ComposerSendActions } from "../src/components/chat/Composer.parts";
import { useConversationMessagingController } from "../src/components/useConversationMessagingController";
import { queryKeys } from "../src/queryKeys";

describe("Composer cancellation feedback", () => {
  it("acknowledges a pending cancellation and blocks repeat submission", () => {
    const onCancel = vi.fn();
    const props = {
      allowSendWhileRunning: false,
      canCancel: true,
      canSend: false,
      destinationError: undefined,
      destinationMode: "project-chat" as const,
      mentionedBusyHandles: [],
      onCancel,
      queue: vi.fn(),
      recipientRequiredMessage: undefined,
      send: vi.fn(),
      showQueue: false,
      steer: vi.fn(),
      targetRequiredRecipientTagged: true,
    };
    const view = render(
      <ComposerSendActions {...props} cancelPending />,
    );

    const pendingButton = screen.getByRole("button", {
      name: "Cancelling…",
    });
    expect(pendingButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pendingButton);
    expect(onCancel).not.toHaveBeenCalled();

    view.rerender(
      <ComposerSendActions {...props} cancelPending={false} />,
    );
    const readyButton = screen.getByRole("button", {
      name: "Cancel run",
    });
    expect(readyButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(readyButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

const conversationId = "cancel-conversation";
const projectId = "cancel-project";
const createdAt = "2026-08-02T12:00:00.000Z";
const conversation: ConversationDto = {
  id: conversationId,
  projectId,
  title: "Cancellation Test",
  defaultEngine: "codex",
  createdAt,
  updatedAt: createdAt,
  archived: false,
};
const agents: AgentDto[] = ["agent-a", "agent-b"].map((id, index) => ({
  id,
  projectId,
  conversationId,
  conversationIds: [conversationId],
  title: `Agent ${index === 0 ? "A" : "B"}`,
  activeEngine: "codex",
  state: {},
  createdAt,
  updatedAt: createdAt,
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
}));

function cancellationController() {
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
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useConversationMessagingController({
        conversationId,
        conversation,
        agents,
        detailAgents: agents,
        engines: [],
        engine: "codex",
        model: "",
        effort: "",
        speed: "",
        statusByAgentId: new Map(),
        healthByAgentId: new Map(),
        agentTitle: agentId =>
          agents.find(agent => agent.id === agentId)?.title ?? "Agent",
      }),
    { wrapper },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("multi-Agent cancellation reconciliation", () => {
  it("retains only failed targets and reuses their request identity on retry", async () => {
    let agentBAttempts = 0;
    const cancelRun = vi.spyOn(api, "cancelRun").mockImplementation(
      async agentId => {
        if (agentId === "agent-b" && agentBAttempts++ === 0) {
          throw new Error("temporary cancellation failure");
        }
        return { cancelled: true, replayed: false };
      },
    );
    const targets = [
      { agentId: "agent-a", runId: "run-a" },
      { agentId: "agent-b", runId: "run-b" },
    ];
    const { result } = cancellationController();
    act(() => {
      result.current.setStopConfirmation({
        targets,
        names: "Agent A, Agent B",
      });
    });

    await act(async () => {
      await result.current.cancelOperationTargets(targets);
    });

    expect(result.current.stopConfirmation).toEqual({
      targets: [{ agentId: "agent-b", runId: "run-b" }],
      names: "Agent B",
    });
    expect(result.current.cancelOperationError?.message).toBe(
      "temporary cancellation failure",
    );
    const firstAgentBRequest = cancelRun.mock.calls.find(
      ([agentId]) => agentId === "agent-b",
    )?.[1];

    await act(async () => {
      await result.current.cancelOperationTargets(
        result.current.stopConfirmation!.targets,
      );
    });

    expect(cancelRun.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent-a",
      "agent-b",
      "agent-b",
    ]);
    expect(cancelRun.mock.calls[2]![1].idempotencyKey).toBe(
      firstAgentBRequest?.idempotencyKey,
    );
    expect(result.current.stopConfirmation).toBeUndefined();
    expect(result.current.cancelOperationError).toBeUndefined();
  });

  it("treats an originally targeted Run that is already inactive as reconciled", async () => {
    vi.spyOn(api, "cancelRun").mockRejectedValue(
      new ApiRequestError(409, "the targeted Run is no longer active"),
    );
    const targets = [{ agentId: "agent-a", runId: "run-a" }];
    const { result } = cancellationController();
    act(() => {
      result.current.setStopConfirmation({ targets, names: "Agent A" });
    });

    await act(async () => {
      await result.current.cancelOperationTargets(targets);
    });

    expect(result.current.stopConfirmation).toBeUndefined();
    expect(result.current.cancelOperationError).toBeUndefined();
  });
});
