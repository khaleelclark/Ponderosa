import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { registerBrowserRoutes } from "../dist/routes/browsers.js";

test("an active hosted desktop view does not block application shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hosted-desktop-close-"));
  const socketPath = path.join(root, "desktop.sock");
  const desktopSocket = createNetServer(connection => connection.on("data", () => {}));
  await new Promise(resolve => desktopSocket.listen(socketPath, resolve));
  const app = Fastify();
  const scope = projectId => ({ projectId, agentId: `project-browser:${projectId}`, runId: `project:${projectId}` });
  registerBrowserRoutes(app, {
    browserProfiles: { savedBrowser: () => null },
    browserSessions: {},
    projectBrowserSessions: {
      get: () => ({ id: "fixture-session", controlEpoch: 1, status: "ready" }),
      manualDesktopSocket: () => socketPath,
    },
    projectExists: projectId => projectId === "fixture-project",
    agentExists: () => true,
    projectDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    operatorBrowserScope: () => scope("fixture-project"),
    projectBrowserScope: scope,
    projectBrowserDto: (_projectId, session) => session,
    getProjectBrowserGrant: () => undefined,
    setProjectBrowserGrant: () => {},
    deleteProjectBrowserGrant: () => {},
    activeProjectBrowserController: () => undefined,
  });
  let websocket;
  let closing;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const ticketResponse = await fetch(`${address}/api/projects/fixture-project/browser/manual`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: address },
      body: JSON.stringify({ action: "ticket", sessionId: "fixture-session", expectedControlEpoch: 1 }),
    });
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json();
    websocket = new WebSocket(address.replace(/^http/, "ws") + ticket.path, ["binary", ticket.protocol], { origin: address });
    await new Promise((resolve, reject) => {
      websocket.once("open", resolve);
      websocket.once("error", reject);
    });
    closing = app.close();
    const outcome = await Promise.race([
      closing.then(() => "closed"),
      new Promise(resolve => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    assert.equal(outcome, "closed", "the upgraded desktop socket must be closed before Fastify waits for server.close()");
  } finally {
    websocket?.terminate();
    await (closing ?? app.close());
    await new Promise(resolve => desktopSocket.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
