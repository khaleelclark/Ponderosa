import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/push-handler.js", import.meta.url), "utf8");

async function deliverPush(clients: Array<{ url: string; visibilityState: "hidden" | "visible" }>, conversationId: string, projectId = "project-1"): Promise<number> {
  let pushHandler: ((event: { data: { json(): object }; waitUntil(work: Promise<void>): void }) => void) | undefined;
  let pending: Promise<void> | undefined;
  const showNotification = vi.fn(async () => undefined);
  const self = {
    addEventListener(type: string, handler: unknown) {
      if (type === "push") pushHandler = handler as typeof pushHandler;
    },
    clients: { matchAll: vi.fn(async () => clients) },
    location: { origin: "https://ponderosa.example" },
    registration: { showNotification },
  };
  runInNewContext(source, { self, URL, Request, Response });
  pushHandler?.({
    data: { json: () => ({ projectId, conversationId, title: "Update", body: "Ready" }) },
    waitUntil(work) { pending = work; },
  });
  await pending;
  return showNotification.mock.calls.length;
}

describe("Web Push active-chat suppression", () => {
  it("does not notify a visible window that is already showing the chat", async () => {
    await expect(deliverPush([
      { url: "https://ponderosa.example/projects/project-1/chats/chat-1", visibilityState: "visible" },
    ], "chat-1")).resolves.toBe(0);
  });

  it("still notifies hidden windows and visible windows on another chat", async () => {
    await expect(deliverPush([
      { url: "https://ponderosa.example/projects/project-1/chats/chat-1", visibilityState: "hidden" },
    ], "chat-1")).resolves.toBe(1);
    await expect(deliverPush([
      { url: "https://ponderosa.example/projects/project-1/chats/chat-2", visibilityState: "visible" },
    ], "chat-1")).resolves.toBe(1);
  });

  it("does not confuse the same chat identifier across projects", async () => {
    await expect(deliverPush([
      { url: "https://ponderosa.example/projects/project-2/chats/chat-1", visibilityState: "visible" },
    ], "chat-1", "project-1")).resolves.toBe(1);
  });
});

describe("Web Push navigation", () => {
  it("asks an existing app window to open the exact destination without replacing its active view", async () => {
    let clickHandler: ((event: { notification: { close(): void; data: { url: string } }; waitUntil(work: Promise<unknown>): void }) => void) | undefined;
    let pending: Promise<unknown> | undefined;
    const client = { url: "https://ponderosa.example/projects/project-1/chats/current", visibilityState: "visible", postMessage: vi.fn(), focus: vi.fn(async () => undefined) };
    const self = {
      addEventListener(type: string, handler: unknown) { if (type === "notificationclick") clickHandler = handler as typeof clickHandler; },
      clients: { matchAll: vi.fn(async () => [client]), openWindow: vi.fn() },
      location: { origin: "https://ponderosa.example" },
    };
    runInNewContext(source, { self, URL, Request, Response });
    clickHandler?.({
      notification: { close: vi.fn(), data: { url: "/projects/project-1/chats/target" } },
      waitUntil(work) { pending = work; },
    });
    await pending;
    expect(client.postMessage).toHaveBeenCalledWith({ type: "ponderosa:open-route", url: "https://ponderosa.example/projects/project-1/chats/target" });
    expect(client.focus).toHaveBeenCalledOnce();
  });
});
