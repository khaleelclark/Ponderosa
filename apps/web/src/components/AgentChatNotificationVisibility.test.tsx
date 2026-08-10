import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { MessageDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPane } from "./chat/ChatPane";
import { useConversationNotificationVisibility } from "./useConversationNotificationVisibility";

const { markNotificationRead } = vi.hoisted(() => ({
  markNotificationRead: vi.fn().mockResolvedValue(undefined),
}));

let intersecting = true;

vi.mock("../api", () => ({
  api: { markNotificationRead },
}));

const message: MessageDto = {
  id: "message-1",
  communicationEventId: "communication-1",
  communicationIntent: "user_dm",
  conversationId: "conversation-1",
  agentId: "agent-1",
  authorAgentId: "agent-1",
  seq: 1,
  role: "assistant",
  text: "Visible response",
  createdAt: "2026-08-09T00:00:00.000Z",
};
const messages = [message];
let queryClient: QueryClient;

function notification(kind: WorkspaceNotificationDto["kind"]): WorkspaceNotificationDto {
  return {
    id: `notification-${kind}`,
    projectId: "project-1",
    conversationId: "conversation-1",
    communicationEventId: message.communicationEventId,
    kind,
    status: "open",
    title: "Visible response",
    body: "Visible response",
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}

function AgentChat({ notifications }: { notifications: WorkspaceNotificationDto[] }): JSX.Element {
  const onCommunicationVisible = useConversationNotificationVisibility(
    { data: notifications },
    queryClient,
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ChatPane
        messages={messages}
        onCommunicationVisible={onCommunicationVisible}
      />
    </QueryClientProvider>
  );
}

describe("Agent Chat notification visibility", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    intersecting = true;
    markNotificationRead.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element): void {
        this.callback(
          [{ isIntersecting: intersecting, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0.5];
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks an ordinary Agent response read once it is rendered in Agent Chat", async () => {
    render(<AgentChat notifications={[notification("direct_responses")]} />);

    await waitFor(() =>
      expect(markNotificationRead).toHaveBeenCalledWith(
        "notification-direct_responses",
      ),
    );
  });

  it("does not dismiss actionable attention merely because its chat is visible", async () => {
    render(<AgentChat notifications={[notification("decision")]} />);

    await waitFor(() => expect(markNotificationRead).not.toHaveBeenCalled());
  });

  it("does not mark an off-screen response read", async () => {
    intersecting = false;
    render(<AgentChat notifications={[notification("direct_responses")]} />);

    await waitFor(() => expect(markNotificationRead).not.toHaveBeenCalled());
  });

  it("waits for a hidden document to become visible", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    render(<AgentChat notifications={[notification("direct_responses")]} />);
    expect(markNotificationRead).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(markNotificationRead).toHaveBeenCalledWith(
        "notification-direct_responses",
      ),
    );
  });

  it("retries a transient acknowledgement failure while the response remains visible", async () => {
    markNotificationRead.mockRejectedValueOnce(new Error("temporary failure"));
    render(<AgentChat notifications={[notification("direct_responses")]} />);

    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledTimes(2));
  });

  it("stops retrying after persistent acknowledgement failures", async () => {
    vi.useFakeTimers();
    markNotificationRead.mockRejectedValue(new Error("persistent failure"));
    render(<AgentChat notifications={[notification("direct_responses")]} />);

    await vi.runAllTimersAsync();
    expect(markNotificationRead).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(markNotificationRead).toHaveBeenCalledTimes(4);
  });

  it("acknowledges an unread notification that arrives after the response is visible", async () => {
    const rendered = render(<AgentChat notifications={[]} />);
    expect(markNotificationRead).not.toHaveBeenCalled();

    rendered.rerender(
      <AgentChat notifications={[notification("direct_responses")]} />,
    );

    await waitFor(() =>
      expect(markNotificationRead).toHaveBeenCalledWith(
        "notification-direct_responses",
      ),
    );
  });
});
