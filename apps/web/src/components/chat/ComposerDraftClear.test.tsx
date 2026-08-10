import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const { getAssetLimits, getConversationDraft, putConversationDraft } =
  vi.hoisted(() => ({
    getAssetLimits: vi.fn(),
    getConversationDraft: vi.fn(),
    putConversationDraft: vi.fn(),
  }));

vi.mock("../../api", () => ({
  api: {
    getAssetLimits,
    getConversationDraft,
    putConversationDraft,
  },
}));

describe("Composer successful draft cleanup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    getAssetLimits.mockResolvedValue({
      maxFileBytes: 8_000_000,
      maxRequestBytes: 8_000_000,
      maxAssetsPerMessage: 20,
      maxMessageBytes: 80_000_000,
      maxAgentBytes: 512_000_000,
      acceptedMediaTypes: [],
    });
    getConversationDraft.mockResolvedValue({
      conversationId: "agent:agent-1",
      ownerId: "owner-1",
      text: "",
      attachmentIds: [],
      revision: 0,
      updatedAt: "2026-08-10T00:00:00.000Z",
      clientId: "",
    });
    putConversationDraft.mockImplementation(
      async (_conversationId: string, request: { ownerId: string }) => ({
        conversationId: "agent:agent-1",
        ownerId: request.ownerId,
        text: "",
        attachmentIds: [],
        revision: 1,
        updatedAt: "2026-08-10T00:00:01.000Z",
        clientId: "page:test",
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("clears local and durable drafts when send succeeds after navigation", async () => {
    let resolveSend: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveSend = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const draftStorageKey = "ponderosa.chat.v1.draft.agent.agent-1";
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <Composer
          disabled={false}
          running={false}
          placeholder="Message Agent"
          onSend={onSend}
          draftStorageKey={draftStorageKey}
          conversationDraftId="agent:agent-1"
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText("Message Agent"), {
      target: { value: "Do the thing" },
    });
    await waitFor(() =>
      expect(window.localStorage.getItem(draftStorageKey)).toBe("Do the thing"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledTimes(1);

    rendered.unmount();
    await act(async () => resolveSend?.());

    await waitFor(() =>
      expect(putConversationDraft).toHaveBeenCalledWith(
        "agent:agent-1",
        expect.objectContaining({
          text: "",
          attachmentIds: [],
        }),
      ),
    );
    expect(window.localStorage.getItem(draftStorageKey)).toBeNull();
  });
});
