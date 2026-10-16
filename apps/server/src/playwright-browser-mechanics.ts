import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserProtocolConnection, BrowserProtocolReply } from "./approved-chrome-connection.js";

export class PlaywrightMechanicsError extends Error {
  constructor(readonly reason: "deadline" | "disconnected") {
    super(reason === "deadline" ? "Playwright operation exceeded its deadline" : "Playwright mechanics are disconnected");
    this.name = "PlaywrightMechanicsError";
  }
}

/** Private, one-client transport from Playwright's public CDP API to our owned pipe.
 * The endpoint is never exposed to a client or stored. Chrome keeps its existing
 * process/profile authority and never opens a debugging TCP port itself. */
export async function connectPlaywrightMechanics(connection: BrowserProtocolConnection) {
  const token = randomUUID();
  let accepted = false;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 16 * 1024 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => !accepted && req.url === `/${token}` && !req.headers.origin,
  });
  let unsubscribe: (() => void) | undefined;
  let socket: WebSocket | undefined;
  let browser: Browser | undefined;
  let unsubscribeClose: (() => void) | undefined;
  let rootSessionId: string | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribeClose?.();
    socket?.terminate();
    server.close();
    // This session belongs only to this transport. Disconnecting mechanics
    // never closes the owned native process or an observer's page session.
    if (rootSessionId) void connection.send("Target.detachFromTarget", { sessionId: rootSessionId }).catch(() => undefined);
  };
  const run = async <T>(operation: (check: () => void) => Promise<T>, timeoutMs: number): Promise<T> => {
    if (closed) throw new PlaywrightMechanicsError("disconnected");
    // The observer pipe stays alive. Its awaited continuations must explicitly
    // check this operation before issuing more reads or publishing state.
    let active = true;
    const check = () => {
      if (!active || closed) throw new PlaywrightMechanicsError("disconnected");
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // A deadline alone leaves an ambiguous action running. Fence its
          // private transport before reporting failure; never retry input.
          close();
          reject(new PlaywrightMechanicsError("deadline"));
        }, timeoutMs);
      });
      const result = await Promise.race([operation(check), expired]);
      check();
      return result;
    } finally { active = false; if (timer) clearTimeout(timer); }
  };
  unsubscribeClose = connection.onClose(close);
  server.on("connection", client => {
    accepted = true;
    socket = client;
    // Stop accepting as soon as our single connection is established.
    server.close();
    const sessions = new Set<string>();
    unsubscribe = connection.onEvent(message => {
      // Playwright owns an independent browser-level CDP session. Root
      // discovery and explicit page attachments belong to the lifecycle
      // observer and must never initialize Playwright's frame/context model.
      if (!message.sessionId || (message.sessionId !== rootSessionId && !sessions.has(message.sessionId))) return;
      if (message.method === "Target.attachedToTarget" && typeof message.params?.sessionId === "string") sessions.add(message.params.sessionId);
      if (message.method === "Target.detachedFromTarget" && typeof message.params?.sessionId === "string") sessions.delete(message.params.sessionId);
      const forwarded = message.sessionId === rootSessionId ? { ...message, sessionId: undefined } : message;
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(forwarded));
    });
    client.on("error", () => close());
    client.on("close", close);
    client.on("message", async data => {
      let message: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      try { message = JSON.parse(data.toString()); } catch { client.close(1003); return; }
      let replied = false;
      const reply = (response: BrowserProtocolReply) => {
        if (closed || replied) return;
        replied = true;
        // Preserve native reply/event order: Playwright installs frame listeners
        // in the frame-tree reply continuation. Deferring this reply to an await
        // lets following execution-context events overtake that initialization.
        const result = response.result;
        if ((message.method === "Target.attachToTarget" || message.method === "Target.attachToBrowserTarget") && typeof result?.sessionId === "string") sessions.add(result.sessionId);
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id,
          ...(response.error ? { error: { code: -32000, message: response.error.message ?? "Browser command failed" } } : { result: result ?? {} }),
          ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      };
      try {
        if (closed || !rootSessionId || (message.sessionId && !sessions.has(message.sessionId))) throw new Error("Playwright session is not owned by this transport");
        const result = await connection.send(message.method, message.params, message.sessionId ?? rootSessionId, reply);
        // Simple behavior doubles may only implement the Promise contract.
        reply({ result });
      } catch (error) {
        reply({ error: { message: error instanceof Error ? error.message : "Browser command failed" } });
      }
    });
  });
  try {
    await run(() => new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); }), 15_000);
    const attached = await run(() => connection.send("Target.attachToBrowserTarget"), 15_000);
    if (typeof attached.sessionId !== "string" || !attached.sessionId) throw new Error("Playwright browser session was not established");
    rootSessionId = attached.sessionId;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Playwright transport failed to start");
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${address.port}/${token}`, { timeout: 15_000, noDefaults: true });
    const identities = new WeakMap<Page, string>();
    return {
      run,
      async page(targetId: string): Promise<Page> {
        return run(async () => {
          // The lifecycle observer can finish attaching a newly created target
          // before Playwright publishes it in context.pages(). Give the second
          // observer a bounded chance to catch up before treating the tab as lost.
          const deadline = Date.now() + 5_000;
          do {
            for (const context of browser!.contexts()) {
              for (const page of context.pages()) {
                if (closed) throw new PlaywrightMechanicsError("disconnected");
                if (page.isClosed()) continue;
                let id = identities.get(page);
                if (!id) {
                  try {
                    const session = await context.newCDPSession(page);
                    if (closed) throw new PlaywrightMechanicsError("disconnected");
                    const info = await session.send("Target.getTargetInfo");
                    if (closed) throw new PlaywrightMechanicsError("disconnected");
                    id = info.targetInfo.targetId;
                    identities.set(page, id);
                    // Kept until browser teardown: detachment must not disturb
                    // the independent lifecycle observer's target accounting.
                  } catch {
                    if (closed) throw new PlaywrightMechanicsError("disconnected");
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
        }, 5_000);
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
