import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { AllChatItemDto } from "@ponderosa/core";
import { api } from "../src/api";
import { AllChatView, allChatReplyUnavailableMessage, allChatSourceRoute, mergeAllChatItems } from "../src/components/AllChatView";

const item = (overrides: Partial<AllChatItemDto> = {}): AllChatItemDto => ({
  communicationEventId: "event-1",
  messageId: "message-1",
  project: { id: "project-1", label: "Project" },
  source: { kind: "project", conversationId: "conversation-1", title: "Planning" },
  author: { kind: "user", label: "User" },
  text: "Message",
  createdAt: "2026-07-19T12:00:00.000Z",
  ...overrides,
});

describe("All Chat view contract", () => {
  it("navigates every item back to its exact source surface", () => {
    expect(allChatSourceRoute(item())).toEqual({
      kind: "conversation", projectId: "project-1", conversationId: "conversation-1", focusMessageId: "event-1",
    });
    expect(allChatSourceRoute(item({ source: { kind: "team", conversationId: "conversation-1", title: "Planning" } }))).toEqual({
      kind: "conversation", projectId: "project-1", conversationId: "conversation-1", focusMessageId: "event-1", channel: "collaboration",
    });
    expect(allChatSourceRoute(item({ source: { kind: "agent", agentId: "agent-1", title: "Reviewer" } }))).toEqual({
      kind: "agent", projectId: "project-1", agentId: "agent-1", focusMessageId: "event-1",
    });
  });

  it("merges refreshed and historical pages by canonical identity in stable order", () => {
    const newer = item({ communicationEventId: "event-2", messageId: "message-2", createdAt: "2026-07-19T12:01:00.000Z" });
    const revised = item({ text: "Revised" });
    expect(mergeAllChatItems([newer, item()], [revised])).toEqual([revised, newer]);
  });

  it("explains that the user cannot reply privately to their own message", () => {
    expect(allChatReplyUnavailableMessage(item())).toBe("You cannot message yourself. Select an Agent-authored message to reply privately to that Agent.");
    expect(allChatReplyUnavailableMessage(item({
      author: { kind: "agent", agentId: "agent-1", label: "Reviewer" },
      directMessageAgent: { id: "agent-1", title: "Reviewer" },
    }))).toBeUndefined();
  });

  it("contains only a selected-source direct-message mutation, never a broadcast composer", () => {
    const source = readFileSync(new URL("../src/components/AllChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("selected.directMessageAgent.id");
    expect(source).not.toContain(">Open Source</Button>");
    expect(source).toContain('onNavigate({ kind: "project", projectId: item.project.id })');
    expect(source).toContain("{item.project.label}</ButtonBase>");
    expect(source).toContain("replyToMessageId: selected.messageId");
    expect(source).not.toContain("shareWithOrganization");
    expect(source).not.toContain("sendConversationMessage");
  });

  it("renders shared Reply controls and routes provider commands through the selected Agent", async () => {
    const first = item({
      author: { kind: "agent", agentId: "agent-1", label: "Reviewer" },
      directMessageAgent: { id: "agent-1", title: "Reviewer" },
      text: "First release note\n\n**Bold detail**",
    });
    const second = item({
      communicationEventId: "event-2",
      messageId: "message-2",
      author: { kind: "agent", agentId: "agent-2", label: "Verifier" },
      directMessageAgent: { id: "agent-2", title: "Verifier" },
      text: "Second release note with distinct context",
      createdAt: "2026-07-19T12:01:00.000Z",
    });
    vi.spyOn(api, "getAllChat").mockResolvedValue({
      items: [first, second],
      history: { limit: 50, hasMore: false },
    });
    vi.spyOn(api, "getAgent").mockResolvedValue({
      agent: { id: "agent-2", projectId: "project-1", title: "Verifier", activeEngine: "codex", model: "gpt-test", conversationIds: ["conversation-1"], state: {}, createdAt: second.createdAt, updatedAt: second.createdAt, archived: false },
    } as never);
    vi.spyOn(api, "getEngineCapabilities").mockResolvedValue([{ engineId: "codex", commands: [{ name: "status", description: "Show status", source: "built-in", acceptsArguments: false, insertText: "/status", status: "available", invocation: "runtime" }], composerCapabilities: [] }] as never);
    const invokeCommand = vi.spyOn(api, "invokeProviderCommand").mockResolvedValue({ invoked: true, name: "status", message: "Session healthy" });
    const sendMessage = vi.spyOn(api, "sendMessage").mockResolvedValue({ queued: false, runId: "run-2", mode: "steer" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><AllChatView onNavigate={vi.fn()} /></QueryClientProvider>);
    });
    const messages = () => view.root.findAll((node) => node.type === "article");
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    expect(view.root.findAllByType("strong").some((node) => node.children.join("") === "Bold detail")).toBe(true);
    expect(messages()[0]!.props["aria-label"]).toContain("First release note");
    expect(messages()[1]!.props["aria-label"]).toContain("Second release note");
    const buttons = (label: string) => view.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label);
    expect(buttons("Copy message")).toHaveLength(2);
    expect(buttons("Reply to message")).toHaveLength(0);
    expect(buttons("Mention Reviewer")).toHaveLength(1);
    expect(buttons("Mention Verifier")).toHaveLength(1);

    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      cancelAnimationFrame: () => undefined,
      setTimeout,
      clearTimeout,
      queueMicrotask,
    });
    const verifierRow = messages()[1]!;
    expect(verifierRow.props.role).toBe("button");
    expect(verifierRow.props.tabIndex).toBe(0);
    const currentTarget = {};
    act(() => verifierRow.props.onKeyDown({
      key: "Enter", target: currentTarget, currentTarget, preventDefault: vi.fn(),
    }));
    await vi.waitFor(() => expect(api.getEngineCapabilities).toHaveBeenCalledWith("project-1", expect.objectContaining({ agentId: "agent-2", engineId: "codex" })));

    const composer = view.root.find((node) => node.props.placeholder === "Message Verifier");
    expect(composer.props.replyTo).toBeUndefined();
    expect(composer.props.guidance).toBeUndefined();
    expect(composer.props.insertTextRequest).toBeUndefined();
    await act(async () => { await composer.props.onCommand({ name: "status" }); });
    expect(invokeCommand).toHaveBeenCalledWith("agent-2", { name: "status" });
    await act(async () => { await composer.props.onSend("Private follow-up"); });
    expect(sendMessage).toHaveBeenCalledWith("agent-2", expect.objectContaining({
      text: "Private follow-up", replyToMessageId: "message-2", activeRunDelivery: "steer",
    }));

    await act(async () => view.unmount());
    client.clear();
    vi.unstubAllGlobals();
  });
});
