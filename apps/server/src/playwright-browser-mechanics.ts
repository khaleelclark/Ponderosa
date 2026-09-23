import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { chromium, type Browser, type Page } from "playwright-core";

interface ProtocolMessage {
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Private, one-client transport from Playwright's public CDP API to our owned pipe.
 * The endpoint is never exposed to a client or stored. Chrome keeps its existing
 * process/profile authority and never opens a debugging TCP port itself. */
export async function connectPlaywrightMechanics(connection: {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(listener: (message: ProtocolMessage) => void): () => void;
  onClose(listener: () => void): () => void;
}) {
  const token = randomUUID();
  let accepted = false;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 16 * 1024 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => !accepted && req.url === `/${token}` && !req.headers.origin,
  });
  let unsubscribe: (() => void) | undefined;
  let socket: WebSocket | undefined;
  let browser: Browser | undefined;
  let unsubscribeClose: (() => void) | undefined;
  const close = () => {
    unsubscribe?.();
    unsubscribeClose?.();
    socket?.terminate();
    server.close();
  };
  unsubscribeClose = connection.onClose(close);
  server.on("connection", client => {
    accepted = true;
    socket = client;
    // Stop accepting as soon as our single connection is established.
    server.close();
    const rootTargets = new Map<string, string>();
    unsubscribe = connection.onEvent(message => {
      // The lifecycle observer and Playwright share one owned CDP pipe. Chrome
      // can report both explicit and automatic attachments for the same target;
      // Playwright needs one root attachment, not the observer's duplicates.
      if (!message.sessionId && message.method === "Target.attachedToTarget") {
        const target = message.params?.targetInfo as { targetId?: string } | undefined;
        const id = target?.targetId;
        const session = message.params?.sessionId;
        if (id && typeof session === "string") {
          if (rootTargets.has(id)) return;
          rootTargets.set(id, session);
        }
      }
      if (!message.sessionId && message.method === "Target.detachedFromTarget") {
        const entry = [...rootTargets].find(([, session]) => session === message.params?.sessionId);
        if (!entry) return;
        rootTargets.delete(entry[0]);
      }
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    });
    client.on("error", () => close());
    client.on("close", () => unsubscribe?.());
    client.on("message", async data => {
      let message: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      try { message = JSON.parse(data.toString()); } catch { client.close(1003); return; }
      try {
        const result = await connection.send(message.method, message.params, message.sessionId);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      } catch (error) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Browser command failed" }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Playwright transport failed to start");
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${address.port}/${token}`, { timeout: 15_000, noDefaults: true });
    const identities = new WeakMap<Page, string>();
    return {
      async page(targetId: string): Promise<Page> {
        // The lifecycle observer can finish attaching a newly created target
        // before Playwright publishes it in context.pages(). Give the second
        // observer a bounded chance to catch up before treating the tab as lost.
        const deadline = Date.now() + 5_000;
        do {
          for (const context of browser!.contexts()) {
            for (const page of context.pages()) {
              if (page.isClosed()) continue;
              let id = identities.get(page);
              if (!id) {
                try {
                  const session = await context.newCDPSession(page);
                  const info = await session.send("Target.getTargetInfo");
                  id = info.targetInfo.targetId;
                  identities.set(page, id);
                  // Kept until browser teardown: detachment must not disturb
                  // the independent lifecycle observer's target accounting.
                } catch {
                  // A target may close while Playwright is discovering it.
                  // Retry the live set until the bounded deadline.
                  continue;
                }
              }
              if (id === targetId) return page;
            }
          }
          if (Date.now() >= deadline || !browser!.isConnected()) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (true);
        throw new Error("The selected browser tab is no longer available to Playwright");
      },
      close,
    };
  } catch {
    close();
    // Connection diagnostics include the private endpoint. Never return that
    // capability in user-visible errors or persistent runtime logs.
    throw new Error("Playwright could not connect to the owned browser process");
  }
}
