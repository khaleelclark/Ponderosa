import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/chat/Composer";
import type { ComposerProps } from "../src/components/chat/Composer";
import { queryKeys } from "../src/queryKeys";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderComposer(props: ComposerProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  client.setQueryData(queryKeys.assetLimits.all, DEFAULT_ASSET_LIMITS);
  const wrap = (component: ReactElement) => (
    <QueryClientProvider client={client}>{component}</QueryClientProvider>
  );
  const result = render(wrap(<Composer {...props} />));
  return {
    ...result,
    rerenderComposer(nextProps: ComposerProps) {
      result.rerender(wrap(<Composer {...nextProps} />));
    },
  };
}

const baseProps: ComposerProps = {
  disabled: false,
  running: false,
  onSend: () => undefined,
};

describe("Composer behavior", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves typed state across rerenders and clears it only after a successful send", async () => {
    const user = userEvent.setup();
    const send = deferred<void>();
    const onSend = vi.fn(() => send.promise);
    const view = renderComposer({ ...baseProps, onSend });
    const input = screen.getByRole("textbox", { name: "Message" });

    await user.type(input, "ship the current behavior");
    view.rerenderComposer({
      ...baseProps,
      onSend,
      placeholder: "Changed without remounting",
    });

    expect((input as HTMLTextAreaElement).value).toBe(
      "ship the current behavior",
    );

    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith(
      "ship the current behavior",
      [],
      [],
      undefined,
      undefined,
    );
    expect((input as HTMLTextAreaElement).value).toBe(
      "ship the current behavior",
    );

    send.resolve();
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("reports mentioned handles on its exact dependencies and resets text when the draft storage key changes", async () => {
    const user = userEvent.setup();
    const mentionHandles = ["Acadia"];
    const firstObserver = vi.fn();
    const secondObserver = vi.fn();
    window.localStorage.setItem("draft:first", "");
    window.localStorage.setItem("draft:second", "second draft");
    const view = renderComposer({
      ...baseProps,
      draftStorageKey: "draft:first",
      mentionHandles,
      onMentionedHandlesChange: firstObserver,
    });
    const input = screen.getByRole("combobox", { name: "Message" });

    await user.type(input, "#Acadia investigate");
    await waitFor(() => {
      expect(firstObserver).toHaveBeenLastCalledWith(["Acadia"]);
    });
    const callsBeforeUnrelatedRerender = firstObserver.mock.calls.length;

    view.rerenderComposer({
      ...baseProps,
      draftStorageKey: "draft:first",
      mentionHandles,
      onMentionedHandlesChange: firstObserver,
      placeholder: "An unrelated prop",
    });

    expect((input as HTMLTextAreaElement).value).toBe(
      "#Acadia investigate",
    );
    expect(firstObserver).toHaveBeenCalledTimes(callsBeforeUnrelatedRerender);

    view.rerenderComposer({
      ...baseProps,
      draftStorageKey: "draft:first",
      mentionHandles,
      onMentionedHandlesChange: secondObserver,
    });
    expect(secondObserver).toHaveBeenCalledOnce();
    expect(secondObserver).toHaveBeenCalledWith(["Acadia"]);

    view.rerenderComposer({
      ...baseProps,
      draftStorageKey: "draft:second",
      mentionHandles,
      onMentionedHandlesChange: secondObserver,
    });
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("second draft");
    });
    expect(window.localStorage.getItem("draft:first")).toBe(
      "#Acadia investigate",
    );
  });

  it("deduplicates insert requests while preserving effect cleanup and dependency behavior", async () => {
    let nextFrame = 40;
    const requestAnimationFrame = vi.fn(() => ++nextFrame);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const firstRequest = { id: "insert-1", text: "Alpha" };
    const view = renderComposer({
      ...baseProps,
      insertTextRequest: firstRequest,
    });
    const input = screen.getByRole("textbox", { name: "Message" });

    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("Alpha ");
    });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    cancelAnimationFrame.mockClear();

    view.rerenderComposer({
      ...baseProps,
      insertTextRequest: firstRequest,
      placeholder: "Unrelated",
    });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).not.toHaveBeenCalledWith(41);

    view.rerenderComposer({
      ...baseProps,
      destinationMode: "fixed",
      insertTextRequest: firstRequest,
    });
    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    view.rerenderComposer({
      ...baseProps,
      destinationMode: "fixed",
      insertTextRequest: { id: "insert-2", text: "Beta" },
    });
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("Alpha Beta ");
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(
      cancelAnimationFrame.mock.calls.filter(([frame]) => frame === 41),
    ).toHaveLength(1);
    expect(
      cancelAnimationFrame.mock.calls.filter(([frame]) => frame === 42),
    ).toHaveLength(1);
  });

  it("preserves a draft through the running transition and exposes explicit steer and queue actions", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const view = renderComposer({
      ...baseProps,
      onSend,
      onQueue,
    });
    const input = screen.getByRole("textbox", { name: "Message" });

    await user.type(input, "follow up after this turn");
    expect(
      screen.queryByRole("button", { name: "Queue message" }),
    ).toBeNull();

    view.rerenderComposer({
      ...baseProps,
      running: true,
      allowSendWhileRunning: true,
      agentResponding: true,
      onSend,
      onQueue,
    });

    expect((input as HTMLTextAreaElement).value).toBe(
      "follow up after this turn",
    );
    expect(
      screen.getByRole("button", { name: "Steer active response" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Queue message" }));

    expect(onQueue).toHaveBeenCalledWith(
      "follow up after this turn",
      [],
      [],
      undefined,
      undefined,
    );
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("");
    });

    view.rerenderComposer({
      ...baseProps,
      onSend,
      onQueue,
    });
    expect(
      screen.queryByRole("button", { name: "Steer active response" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Queue message" }),
    ).toBeNull();
  });

  it("keeps the latest Direct recipient selected until it is cleared", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderComposer({
      ...baseProps,
      destinationMode: "project-chat",
      allowUnmentionedSend: true,
      mentionHandles: ["Spruce"],
      continueWith: {
        agentId: "agent-spruce",
        handle: "Spruce",
        title: "Spruce",
        responding: false,
        selectionKey: "direct-inactive",
      },
      onSend,
    });

    expect(screen.getByText("To: Spruce")).toBeTruthy();
    expect(screen.queryByText(
      "Sending without a recipient starts a new Agent.",
    )).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with Spruce" })).toBeNull();

    const input = screen.getByRole("combobox", { name: "Message" });
    await user.type(input, "Continue this work");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenLastCalledWith(
      "Continue this work",
      [],
      [],
      undefined,
      { implicitRecipientId: "agent-spruce" },
    );

    const selectedDestination = screen.getByRole("button", {
      name: "To: Spruce. Press Delete or Backspace to clear.",
    });
    expect(selectedDestination.getAttribute("title")).toBe("To: Spruce");
    selectedDestination.focus();
    await user.keyboard("{Backspace}");
    expect(screen.queryByText("To: Spruce")).toBeNull();
    expect(screen.getByText(
      "Sending without a recipient starts a new Agent.",
    )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Spruce" })).toBeNull();

    await user.type(input, "Start fresh");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenLastCalledWith(
      "Start fresh",
      [],
      [],
      undefined,
      undefined,
    );
  });

  it("submits multiple broadcast Agent mentions with their canonical bindings", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderComposer({
      ...baseProps,
      destinationMode: "project-chat",
      allowUnmentionedSend: true,
      mentionHandles: ["broadcast", "Spruce", "Pine"],
      mentionBindings: [
        { handle: "Spruce", agentId: "agent-spruce" },
        { handle: "Pine", agentId: "agent-pine" },
      ],
      onSend,
    });

    await user.type(
      screen.getByRole("combobox", { name: "Message" }),
      "#broadcast #Spruce #Pine use this on your next run",
    );
    expect(screen.getByText("Next run: #Spruce +1")).toBeTruthy();
    expect(screen.getByTitle(
      "Deliver on next run to #Spruce, #Pine. Passive delivery; no Run or reply requested.",
    )).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith(
      "#broadcast #Spruce #Pine use this on your next run",
      [],
      [],
      undefined,
      {
        mentionedAgents: [
          { handle: "Spruce", agentId: "agent-spruce" },
          { handle: "Pine", agentId: "agent-pine" },
        ],
      },
    );
  });

  it("keeps an active response visibly and canonically selected", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderComposer({
      ...baseProps,
      destinationMode: "project-chat",
      allowUnmentionedSend: true,
      continueWith: {
        agentId: "agent-spruce",
        handle: "Spruce",
        title: "Spruce",
        responding: true,
        selectionKey: "direct-active",
      },
      onSend,
    });

    expect(screen.getByText("To: Spruce")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "To: Spruce. Press Delete or Backspace to clear.",
    })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Spruce" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Steer this run");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenLastCalledWith(
      "Steer this run",
      [],
      [],
      undefined,
      { implicitRecipientId: "agent-spruce" },
    );
  });

  it("does not reselect a cleared Direct recipient when its display name changes", async () => {
    const user = userEvent.setup();
    const view = renderComposer({
      ...baseProps,
      destinationMode: "project-chat",
      allowUnmentionedSend: true,
      continueWith: {
        agentId: "agent-spruce",
        handle: "Spruce",
        title: "Spruce",
        selectionKey: "direct-one",
      },
    });

    const selectedDestination = screen.getByRole("button", {
      name: "To: Spruce. Press Delete or Backspace to clear.",
    });
    selectedDestination.focus();
    await user.keyboard("{Backspace}");
    view.rerenderComposer({
      ...baseProps,
      destinationMode: "project-chat",
      allowUnmentionedSend: true,
      continueWith: {
        agentId: "agent-spruce",
        handle: "Redwood",
        title: "Redwood",
        selectionKey: "direct-one",
      },
    });

    expect(screen.queryByText("To: Redwood")).toBeNull();
    expect(screen.getByText(
      "Sending without a recipient starts a new Agent.",
    )).toBeTruthy();

    view.rerenderComposer({
      ...baseProps,
      destinationMode: "project-chat",
      allowUnmentionedSend: true,
      continueWith: {
        agentId: "agent-spruce",
        handle: "Redwood",
        title: "Redwood",
        selectionKey: "direct-two",
      },
    });
    expect(screen.getByText("To: Redwood")).toBeTruthy();
  });
});
