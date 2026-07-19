import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { gunzipSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentEvent, AgentPortablePackageDto, ApiPriceProfile, ArtifactDto, CommunicationEvent, ContinueOptions, ConversationDetailDto, EffortOption, ModelOption, OpenRuntimeSessionOptions, ProjectEngineCapabilitiesDto, RuntimeSession, RuntimeTurnInput, SeedOptions } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store, WorkspaceStore, managedArtifactContentPath, artifactContentPath } from "@ponderosa/agents";
import { ClaudeStreamSession, streamProcess } from "@ponderosa/engines";
import { boundedSeedHistory, conciseConversationTitle, createServer, isProjectFileReferenceAllowed, normalizeExternalCitations, notificationKindForCommunication, notificationPreferenceMatches, parseGitStatus, projectedRunCost, PROVIDER_TOOL_CONTRACT_HASH, runtimeIdentityPrompt, semanticConversationTitle, workspaceAgentEventCategory, type EngineRegistration } from "../src/app.js";
import type { BrowserDriver } from "../src/browser-session-manager.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

function activeRunCancellationPayload(store: AgentStore, agentId: string, idempotencyKey: string) {
  const targetRunId = new CoordinationV3Store(store.sqlite).agentSnapshot(agentId).activeRun?.id;
  expect(targetRunId, `expected Agent ${agentId} to have an active Run`).toBeTruthy();
  return { targetRunId: targetRunId!, idempotencyKey };
}

async function deleteAgentsWithServerPreview(
  app: ReturnType<typeof createServer>,
  projectId: string,
  rootAgentIds: string[],
) {
  const preview = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/agent-deletions/preview`,
    payload: { rootAgentIds },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const exact = preview.json<{ rootAgentIds: string[]; previewHash: string }>();
  return app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/agent-deletions/commit`,
    payload: exact,
  });
}

function appendBroadcast(store: AgentStore, projectId: string, conversationId: string, text: string) {
  const eventId = randomUUID();
  store.appendCommunicationEvent({
    eventId, schemaVersion: 1, projectId, conversationId,
    sender: { kind: "user", userId: "local-operator" },
    intent: "broadcast", audience: { kind: "organization", organizationId: projectId },
    text, createdAt: new Date().toISOString(),
  });
  return store.appendConversationMessage(conversationId, { text }, undefined, "main", undefined, undefined, eventId);
}

function appendCanonicalMessage(
  store: AgentStore,
  projectId: string,
  conversationId: string,
  input: Parameters<AgentStore["appendConversationMessage"]>[1],
  authorAgentId?: string,
  channel: Parameters<AgentStore["appendConversationMessage"]>[3] = "main",
  deliveryIntents?: Parameters<AgentStore["appendConversationMessage"]>[4],
  messageReceiptKey?: string,
  audienceAgentIds = [...new Set((deliveryIntents ?? []).map((intent) => intent.targetAgentId))],
) {
  const eventId = randomUUID();
  const event: CommunicationEvent = channel === "collaboration"
    ? {
        eventId, schemaVersion: 2, projectId, conversationId,
        sender: authorAgentId ? { kind: "agent", agentId: authorAgentId } : { kind: "user", userId: "local-operator" },
        intent: "collaboration", audience: { kind: "agents", agentIds: audienceAgentIds as [string, ...string[]] },
        text: input.text, createdAt: new Date().toISOString(),
      }
    : audienceAgentIds.length
      ? {
          eventId, schemaVersion: 2, projectId, conversationId,
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: audienceAgentIds.length === 1
            ? { kind: "user_agent", userId: "local-operator", agentId: audienceAgentIds[0]! }
            : { kind: "user_agents", userId: "local-operator", agentIds: audienceAgentIds as [string, ...string[]] },
          text: input.text, createdAt: new Date().toISOString(),
        }
      : {
          eventId, schemaVersion: 1, projectId, conversationId,
          sender: authorAgentId ? { kind: "agent", agentId: authorAgentId } : { kind: "user", userId: "local-operator" },
          intent: "broadcast", audience: { kind: "organization", organizationId: projectId },
          text: input.text, createdAt: new Date().toISOString(),
        };
  store.appendCommunicationEvent(event);
  return store.appendConversationMessage(
    conversationId, input, authorAgentId, channel, deliveryIntents, messageReceiptKey, eventId,
  );
}

describe("workspace synchronization policy", () => {
  it("keeps high-frequency execution deltas off the global workspace log", () => {
    expect(workspaceAgentEventCategory({ type: "text", delta: "chunk", executionId: "run" })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "reasoning", delta: "thought", executionId: "run" })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "agent_output", executionId: "run", text: "done", sourceSeqStart: 1, sourceSeqEnd: 2 })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "turn_done" })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "agent_lifecycle", executionId: "run", status: "running", reason: "user_message" })).toBe("lifecycle");
    expect(workspaceAgentEventCategory({ type: "file_change", path: "src/app.ts", kind: "edit" })).toBe("file");
  });

  it("routes notifications from structural communication intent only", () => {
    const base = { eventId: "event", schemaVersion: 2 as const, projectId: "project", conversationId: "chat", sender: { kind: "agent" as const, agentId: "agent" }, text: "Done", createdAt: new Date(0).toISOString() };
    const broadcast = { ...base, intent: "broadcast" as const, audience: { kind: "organization" as const, organizationId: "project" } };
    const collaboration = { ...base, intent: "collaboration" as const, audience: { kind: "agents" as const, agentIds: ["peer"] } };
    expect(notificationKindForCommunication(broadcast)).toBe("broadcasts");
    expect(notificationPreferenceMatches("project_responses", broadcast, "broadcasts")).toBe(true);
    expect(notificationKindForCommunication(collaboration)).toBe("collaboration");
    expect(notificationPreferenceMatches("project_responses", collaboration, "collaboration")).toBe(false);
    expect(notificationPreferenceMatches("mentions", collaboration, "collaboration")).toBe(false);
    expect(notificationPreferenceMatches("all_messages", collaboration, "collaboration")).toBe(true);
  });

  it("derives a bounded local title without routing labels", () => {
    expect(conciseConversationTitle("#broadcast #Agent fix the flaky cache invalidation please today")).toBe("fix the flaky cache invalidation please");
    expect(conciseConversationTitle("hello")).toBeUndefined();
  });

  it("derives semantic title-case titles from the first exchange", () => {
    expect(semanticConversationTitle("Track down the flaky cache invalidation", "I found the stale cursor path")).toBe("Found Stale Cursor Path");
  });

  it("normalizes explicit external sources and rejects local or credentialed URLs", () => {
    expect(normalizeExternalCitations([{ url: "https://example.com/docs#part", title: "  Product   docs " }], "2026-01-01T00:00:00.000Z")).toEqual([
      { url: "https://example.com/docs", title: "Product docs", verifiedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(() => normalizeExternalCitations([{ url: "http://127.0.0.1/private", title: "Private" }])).toThrow(/external/);
    expect(() => normalizeExternalCitations([{ url: "https://user:secret@example.com", title: "Credentials" }])).toThrow(/external/);
  });
});

describe("localhost link preview registration", () => {
  it("requires browser authentication, exact active-run ownership, and tears down after the run", async () => {
    const project = store.createProject({ label: "Preview", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Preview room" });
    const agent = store.createAgent(project.id, { title: "Previewer", engine: "codex", conversationId: room.id });
    const otherProject = store.createProject({ label: "Other", hostPath: repoDir });
    const app = createServer({ dataDir, store, engines, logger: false, authToken: "preview-secret" });
    const headers = { authorization: "Bearer preview-secret" };
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, headers: { authorization: "Bearer preview-secret" }, payload: { text: "Serve the app" } });
    await waitForSeedCount(1);
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
    const runId = health.json<{ agents: Array<{ runtimeActivity?: { executionId: string } }> }>().agents[0]!.runtimeActivity!.executionId;
    const scope = { projectId: project.id, agentId: agent.id, runId, conversationId: room.id };
    const unauthorized = await app.inject({ method: "POST", url: "/api/link-previews", payload: { url: "http://localhost:5173/app", ...scope } });
    expect(unauthorized.statusCode).toBe(401);

    const accepted = await app.inject({ method: "POST", url: "/api/link-previews", headers, payload: { url: "http://localhost:5173/app", ...scope } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ targetOrigin: "http://127.0.0.1:5173", openUrl: expect.stringMatching(/^\/api\/link-previews\/.+\/app$/) });

    for (const badScope of [
      { ...scope, projectId: otherProject.id },
      { ...scope, agentId: randomUUID() },
      { ...scope, runId: randomUUID() },
      { ...scope, conversationId: randomUUID() },
    ]) expect((await app.inject({ method: "POST", url: "/api/link-previews", headers, payload: { url: "http://localhost:5173/app", ...badScope } })).statusCode).toBe(409);

    for (const url of ["http://localhost/no-port", "https://localhost:5173/", "http://192.168.1.5:5173/", "file:///etc/passwd", "http://user:pass@localhost:5173/"]) {
      expect((await app.inject({ method: "POST", url: "/api/link-previews", headers, payload: { url, ...scope } })).statusCode).toBe(400);
    }
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`, headers,
      payload: activeRunCancellationPayload(store, agent.id, "preview-stop"),
    })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const afterCancel = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
      if (!afterCancel.json<{ agents: Array<{ runtimeActivity?: unknown }> }>().agents[0]?.runtimeActivity) break;
      await sleep(10);
    }
    expect((await app.inject({ method: "GET", url: accepted.json<{ openUrl: string }>().openUrl, headers })).statusCode).toBe(404);
    await app.close();
  });

  it("proxies bounded Vite HMR sockets bidirectionally without forwarding operator credentials", async () => {
    const upstreamHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const upstreamUpgradePaths: string[] = [];
    const upgradedSockets = new Set<import("node:stream").Duplex>();
    const upstreamPaths: string[] = [];
    let openEventsClosed!: () => void;
    let openStreamClosed!: () => void;
    let stubbornSocketClosed!: () => void;
    const openEventsTeardown = new Promise<void>((resolve) => { openEventsClosed = resolve; });
    const openStreamTeardown = new Promise<void>((resolve) => { openStreamClosed = resolve; });
    const stubbornTeardown = new Promise<void>((resolve) => { stubbornSocketClosed = resolve; });
    const upstreamServer = createHttpServer((request, response) => {
      upstreamPaths.push(request.url ?? "");
      if (request.url === "/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: ready\n\n");
        return;
      }
      if (request.url === "/open-events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        response.write("data: open\n\n");
        request.once("close", openEventsClosed);
        return;
      }
      if (request.url === "/open-stream") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        response.write("open");
        request.once("close", openStreamClosed);
        return;
      }
      if (request.url === "/nested/assets/main.js" || request.url === "/favicon.ico") {
        response.writeHead(200, { "content-type": "application/javascript" });
        response.end("export default true");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><head><link rel="icon" href="/favicon.ico"></head><body><script src="./assets/main.js"></script></body></html>');
    });
    const upstreamWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
    upstreamServer.on("upgrade", (request, socket, head) => {
      upgradedSockets.add(socket);
      socket.once("close", () => upgradedSockets.delete(socket));
      upstreamHeaders.push(request.headers);
      upstreamUpgradePaths.push(request.url ?? "");
      if (request.url === "/stubborn") {
        const key = request.headers["sec-websocket-key"];
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${request.headers["sec-websocket-protocol"]}\r\n\r\n`);
        socket.once("end", stubbornSocketClosed);
        socket.once("close", stubbornSocketClosed);
        socket.resume();
        return;
      }
      const accept = () => upstreamWss.handleUpgrade(request, socket, head, (client) => {
        client.on("message", (data, binary) => client.send(data, { binary }));
      });
      if (request.url?.startsWith("/slow")) setTimeout(() => { if (!socket.destroyed) accept(); }, 250).unref();
      else accept();
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("missing upstream address");

    const project = store.createProject({ label: "Preview", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Preview room" });
    const agent = store.createAgent(project.id, { title: "Previewer", engine: "codex", conversationId: room.id });
    const app = createServer({
      dataDir,
      store,
      engines,
      logger: false,
      authToken: "preview-secret",
      linkPreviewScheduling: {
        heartbeatMs: 1_000,
        upstreamHandshakeTimeoutMs: 100,
        maxConnectionsPerRegistration: 2,
        maxTotalConnections: 3,
        maxPayloadBytes: 4_096,
        maxBufferedBytes: 1_024,
        maxPendingFrames: 2,
        closeGraceMs: 30,
      },
    });
    adapter.mode = "hang";
    const headers = { authorization: "Bearer preview-secret" };
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, headers, payload: { text: "Serve the app" } });
    await waitForSeedCount(1);
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
    const runId = health.json<{ agents: Array<{ runtimeActivity?: { executionId: string } }> }>().agents[0]!.runtimeActivity!.executionId;
    const registered = await app.inject({
      method: "POST",
      url: "/api/link-previews",
      headers,
      payload: { url: `http://127.0.0.1:${upstreamAddress.port}/nested/index.html?mode=dev`, projectId: project.id, agentId: agent.id, runId, conversationId: room.id },
    });
    expect(registered.statusCode).toBe(200);
    const preview = registered.json<{ id: string; openUrl: string }>();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appAddress = app.server.address();
    if (!appAddress || typeof appAddress === "string") throw new Error("missing app address");
    const wsUrl = `ws://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/__ws/hmr?token=vite-token`;
    const connect = (url = wsUrl) => new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(url, "vite-hmr", {
        origin: "null",
        headers: { authorization: "Bearer operator-secret", cookie: "session=operator", "x-oauth-state": "private" },
      });
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
    const echo = (client: WebSocket, value: string) => new Promise<string>((resolve, reject) => {
      client.once("message", (data) => resolve(data.toString()));
      client.once("error", reject);
      client.send(value);
    });
    const first = await connect();
    const second = await connect();
    expect(await echo(first, "hmr-update")).toBe("hmr-update");
    expect(await echo(second, "vite-ping")).toBe("vite-ping");
    expect(upstreamHeaders).toHaveLength(2);
    for (const forwarded of upstreamHeaders) {
      expect(forwarded.authorization).toBeUndefined();
      expect(forwarded.cookie).toBeUndefined();
      expect(forwarded["x-oauth-state"]).toBeUndefined();
      expect(forwarded.origin).toBe(`http://127.0.0.1:${upstreamAddress.port}`);
      expect(forwarded.host).toBe(`127.0.0.1:${upstreamAddress.port}`);
    }

    const rejectedStatus = (url: string, protocol: string, origin: string) => new Promise<number>((resolve, reject) => {
      const client = new WebSocket(url, protocol, { origin });
      client.once("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.destroy(); });
      client.once("open", () => { client.close(); reject(new Error("upgrade unexpectedly opened")); });
      client.once("error", () => undefined);
    });
    expect(await rejectedStatus(wsUrl, "vite-hmr", "https://foreign.example")).toBe(403);
    expect(await rejectedStatus(wsUrl, "not-vite", "null")).toBe(400);
    expect(await rejectedStatus(`${wsUrl}&host=external.example`, "vite-hmr", "null")).toBe(400);
    expect(await rejectedStatus(`${wsUrl}&token=duplicate`, "vite-hmr", "null")).toBe(400);
    expect(await rejectedStatus(wsUrl.replace(preview.id, randomUUID()), "vite-hmr", "null")).toBe(404);
    expect(await rejectedStatus(wsUrl, "vite-hmr", "null")).toBe(429);

    const rawUpgradeStatus = (target: string, key = Buffer.alloc(16, 7).toString("base64")) => new Promise<number>((resolve, reject) => {
      const tcp = connectTcp(appAddress.port, "127.0.0.1", () => {
        tcp.write(`${[
          `GET ${target} HTTP/1.1`,
          `Host: 127.0.0.1:${appAddress.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Origin: null",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Protocol: vite-hmr",
          "",
          "",
        ].join("\r\n")}`);
      });
      let response = "";
      tcp.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (!response.includes("\r\n")) return;
        const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
        tcp.destroy();
        resolve(status);
      });
      tcp.once("error", reject);
    });
    const upgradePath = `/api/link-previews/${preview.id}/__ws/hmr?token=vite-token`;
    expect(await rawUpgradeStatus(upgradePath, "malformed-key")).toBe(400);
    expect(await rawUpgradeStatus(`${upgradePath.replace("/hmr", "/%ZZ")}`)).toBe(400);
    expect(await rawUpgradeStatus(`ws://user:secret@127.0.0.1:${appAddress.port}${upgradePath}`)).toBe(400);
    expect(await rawUpgradeStatus(`ws://external.example:${appAddress.port}${upgradePath}`)).toBe(400);
    expect(await rawUpgradeStatus(`ws://127.0.0.1:${appAddress.port + 1}${upgradePath}`)).toBe(400);

    const page = await fetch(`http://127.0.0.1:${appAddress.port}${preview.openUrl}`, { headers });
    const html = await page.text();
    expect(html).toContain(`<base href="/api/link-previews/${preview.id}/nested/">`);
    expect(html).toContain(`/api/link-previews/${preview.id}/favicon.ico`);
    expect(html).toContain(`./assets/main.js`);
    expect(html).toContain(`/api/link-previews/${preview.id}/__ws`);
    const bootstrap = html.match(/<script>(.*?)<\/script>/s)?.[1];
    expect(bootstrap).toBeTruthy();
    const websocketCalls: Array<{ url: string; protocols?: string | string[] }> = [];
    class BrowserWebSocket {
      constructor(url: string, protocols?: string | string[]) { websocketCalls.push({ url, protocols }); }
    }
    const sandbox = {
      window: { WebSocket: BrowserWebSocket },
      document: { baseURI: `http://127.0.0.1:${appAddress.port}${preview.openUrl}` },
      location: { protocol: "http:", hostname: "127.0.0.1", port: String(appAddress.port), host: `127.0.0.1:${appAddress.port}` },
      URL,
    };
    runInNewContext(bootstrap!, sandbox);
    const currentOriginViteUrl = `ws://127.0.0.1:${appAddress.port}/nested/?token=vite-token`;
    new sandbox.window.WebSocket(currentOriginViteUrl, "vite-hmr");
    new sandbox.window.WebSocket(`ws://127.0.0.1:${upstreamAddress.port}/nested/?token=vite-token`, "vite-ping");
    const occupiedPorts = new Set([upstreamAddress.port, appAddress.port]);
    let foreignPort = upstreamAddress.port;
    do foreignPort = foreignPort === 65_535 ? 1 : foreignPort + 1;
    while (occupiedPorts.has(foreignPort));
    new sandbox.window.WebSocket(`ws://127.0.0.1:${foreignPort}/nested/?token=vite-token`, "vite-hmr");
    expect(websocketCalls).toEqual([
      { url: `ws://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/__ws/nested/?token=vite-token`, protocols: "vite-hmr" },
      { url: `ws://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/__ws/nested/?token=vite-token`, protocols: "vite-ping" },
      { url: `ws://127.0.0.1:${foreignPort}/nested/?token=vite-token`, protocols: "vite-hmr" },
    ]);
    const nestedAsset = await fetch(`http://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/nested/assets/main.js`, { headers });
    expect(nestedAsset.status).toBe(200);
    expect(upstreamPaths).toContain("/nested/assets/main.js");
    expect((await fetch(`http://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/__ws/hmr`, { headers })).status).toBe(426);
    const events = await fetch(`http://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/events`, { headers });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(await events.text()).toBe("data: ready\n\n");

    const oversizedClosed = new Promise<number>((resolve) => first.once("close", resolve));
    first.send(Buffer.alloc(8_192));
    expect([1009, 1011]).toContain(await oversizedClosed);
    const backpressured = await connect();
    const backpressureClosed = new Promise<number>((resolve) => backpressured.once("close", resolve));
    backpressured.send(Buffer.alloc(2_048));
    expect(await backpressureClosed).toBe(1013);
    const pendingLimited = await connect(wsUrl.replace("/hmr?", "/slow?"));
    const pendingClosed = new Promise<number>((resolve) => pendingLimited.once("close", resolve));
    pendingLimited.send("");
    pendingLimited.send("");
    pendingLimited.send("");
    expect(await pendingClosed).toBe(1013);
    const handshakeLimited = await connect(wsUrl.replace("/hmr?", "/slow-timeout?"));
    const handshakeClosed = new Promise<number>((resolve) => handshakeLimited.once("close", resolve));
    expect([1006, 1011]).toContain(await handshakeClosed);
    const replacement = await connect();

    const closeRegistration = await app.inject({
      method: "POST",
      url: "/api/link-previews",
      headers,
      payload: { url: `http://127.0.0.1:${upstreamAddress.port}/stubborn`, projectId: project.id, agentId: agent.id, runId, conversationId: room.id },
    });
    const closePreview = closeRegistration.json<{ id: string }>();
    const explicitlyClosedClient = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/link-previews/${closePreview.id}/__ws/stubborn`, "vite-ping", { origin: "null" });
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
    await expect.poll(() => upstreamUpgradePaths.includes("/stubborn")).toBe(true);
    const explicitlyClosed = new Promise<number>((resolve) => explicitlyClosedClient.once("close", resolve));
    expect((await app.inject({ method: "DELETE", url: `/api/link-previews/${closePreview.id}`, headers })).json()).toEqual({ closed: true });
    expect(await explicitlyClosed).toBe(1001);
    await stubbornTeardown;

    const openEvents = await fetch(`http://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/open-events`, { headers });
    const openEventsReader = openEvents.body!.getReader();
    expect(new TextDecoder().decode((await openEventsReader.read()).value)).toContain("data: open");
    const openStream = await fetch(`http://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/open-stream`, { headers });
    const openStreamReader = openStream.body!.getReader();
    expect(new TextDecoder().decode((await openStreamReader.read()).value)).toBe("open");

    const secondClosed = new Promise<number>((resolve) => second.once("close", resolve));
    const replacementClosed = new Promise<number>((resolve) => replacement.once("close", resolve));
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`, headers,
      payload: activeRunCancellationPayload(store, agent.id, "proxy-stop"),
    })).statusCode).toBe(200);
    expect([1001, 1008]).toContain(await secondClosed);
    expect([1001, 1008]).toContain(await replacementClosed);
    await Promise.all([openEventsTeardown, openStreamTeardown]);
    await openEventsReader.cancel().catch(() => undefined);
    await openStreamReader.cancel().catch(() => undefined);
    expect(await rejectedStatus(wsUrl, "vite-hmr", "null")).toBe(404);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const afterCancel = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
      if (!afterCancel.json<{ agents: Array<{ runtimeActivity?: unknown }> }>().agents[0]?.runtimeActivity) break;
      await sleep(10);
    }
    store.clearResumeSession(agent.id, "shutdown teardown test");
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, headers, payload: { text: "Serve once more" } });
    await waitForSeedCount(2);
    const nextHealth = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
    const nextRunId = nextHealth.json<{ agents: Array<{ runtimeActivity?: { executionId: string } }> }>().agents[0]!.runtimeActivity!.executionId;
    const shutdownRegistration = await app.inject({
      method: "POST",
      url: "/api/link-previews",
      headers,
      payload: { url: `http://127.0.0.1:${upstreamAddress.port}/`, projectId: project.id, agentId: agent.id, runId: nextRunId, conversationId: room.id },
    });
    const shutdownPreview = shutdownRegistration.json<{ id: string }>();
    const shutdownClient = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/link-previews/${shutdownPreview.id}/__ws/`, "vite-hmr", { origin: "null" });
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
    const shutdownClosed = new Promise<number>((resolve) => shutdownClient.once("close", resolve));
    await app.close();
    expect(await shutdownClosed).toBe(1001);
    for (const client of upstreamWss.clients) client.terminate();
    await new Promise<void>((resolve) => upstreamWss.close(() => resolve()));
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise<void>((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve()));
  }, 20_000);

  it("expires the capability and both socket legs while the owning run remains active", async () => {
    const upstreamWss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: false });
    await new Promise<void>((resolve) => upstreamWss.once("listening", resolve));
    const upstreamAddress = upstreamWss.address();
    if (typeof upstreamAddress === "string") throw new Error("missing upstream address");
    const project = store.createProject({ label: "Expiring preview", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Preview room" });
    const agent = store.createAgent(project.id, { title: "Previewer", engine: "codex", conversationId: room.id });
    const app = createServer({
      dataDir,
      store,
      engines,
      logger: false,
      linkPreviewScheduling: { registrationTtlMs: 80, heartbeatMs: 1_000 },
    });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Serve briefly" } });
    await waitForSeedCount(1);
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    const runId = health.json<{ agents: Array<{ runtimeActivity?: { executionId: string } }> }>().agents[0]!.runtimeActivity!.executionId;
    const registered = await app.inject({
      method: "POST",
      url: "/api/link-previews",
      payload: { url: `http://127.0.0.1:${upstreamAddress.port}/`, projectId: project.id, agentId: agent.id, runId, conversationId: room.id },
    });
    const preview = registered.json<{ id: string }>();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appAddress = app.server.address();
    if (!appAddress || typeof appAddress === "string") throw new Error("missing app address");
    const wsUrl = `ws://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/__ws/`;
    const client = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = new WebSocket(wsUrl, "vite-hmr", { origin: "null" });
      candidate.once("open", () => resolve(candidate));
      candidate.once("error", reject);
    });
    const expired = new Promise<number>((resolve) => client.once("close", resolve));
    expect(await expired).toBe(1008);
    const retryStatus = await new Promise<number>((resolve, reject) => {
      const candidate = new WebSocket(wsUrl, "vite-hmr", { origin: "null" });
      candidate.once("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.destroy(); });
      candidate.once("open", () => reject(new Error("expired preview unexpectedly reopened")));
      candidate.once("error", () => undefined);
    });
    expect(retryStatus).toBe(404);
    await app.close();
    await new Promise<void>((resolve) => upstreamWss.close(() => resolve()));
  });

  it("bounds reconnects and revokes an open socket when its run completes normally", async () => {
    const upstreamWss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: false });
    await new Promise<void>((resolve) => upstreamWss.once("listening", resolve));
    const upstreamAddress = upstreamWss.address();
    if (typeof upstreamAddress === "string") throw new Error("missing upstream address");
    const project = store.createProject({ label: "Completing preview", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Preview room" });
    const agent = store.createAgent(project.id, { title: "Previewer", engine: "codex", conversationId: room.id });
    const app = createServer({
      dataDir,
      store,
      engines,
      logger: false,
      linkPreviewScheduling: { heartbeatMs: 1_000, maxReconnectsPerWindow: 2, reconnectWindowMs: 5_000 },
    });
    let finishRun!: () => void;
    adapter.beforeResponse = () => new Promise<void>((resolve) => { finishRun = resolve; });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Serve until done" } });
    await waitForSeedCount(1);
    await expect.poll(() => typeof finishRun).toBe("function");
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    const runId = health.json<{ agents: Array<{ runtimeActivity?: { executionId: string } }> }>().agents[0]!.runtimeActivity!.executionId;
    const registered = await app.inject({
      method: "POST",
      url: "/api/link-previews",
      payload: { url: `http://127.0.0.1:${upstreamAddress.port}/`, projectId: project.id, agentId: agent.id, runId, conversationId: room.id },
    });
    const preview = registered.json<{ id: string }>();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appAddress = app.server.address();
    if (!appAddress || typeof appAddress === "string") throw new Error("missing app address");
    const wsUrl = `ws://127.0.0.1:${appAddress.port}/api/link-previews/${preview.id}/__ws/`;
    const connect = () => new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(wsUrl, "vite-hmr", { origin: "null" });
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
    const first = await connect();
    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await firstClosed;
    const second = await connect();
    const reconnectRejected = new Promise<number>((resolve, reject) => {
      const client = new WebSocket(wsUrl, "vite-hmr", { origin: "null" });
      client.once("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.destroy(); });
      client.once("open", () => reject(new Error("reconnect limit unexpectedly opened")));
      client.once("error", () => undefined);
    });
    expect(await reconnectRejected).toBe(429);

    const completedClose = new Promise<number>((resolve) => second.once("close", resolve));
    finishRun();
    await waitForRun(agent.id);
    expect(await completedClose).toBe(1001);
    await app.close();
    for (const client of upstreamWss.clients) client.terminate();
    await new Promise<void>((resolve) => upstreamWss.close(() => resolve()));
  });
});

describe("link favicon loading", () => {
  it("serves a bounded same-origin favicon and rejects unsafe targets before loading", async () => {
    const linkFaviconLoader = vi.fn(async () => ({ body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" }));
    const app = createServer({ dataDir, store, engines, logger: false, linkFaviconLoader });
    const favicon = await app.inject({ method: "GET", url: "/api/link-favicon?url=https%3A%2F%2Fdocs.example.com%2Fguide" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["content-type"]).toContain("image/png");
    expect(favicon.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(linkFaviconLoader).toHaveBeenCalledWith(new URL("https://docs.example.com/favicon.ico"));

    for (const url of ["http://example.com/", "https://localhost:443/", "https://127.0.0.1/", "file:///etc/passwd", "https://user:secret@example.com/"]) {
      expect((await app.inject({ method: "GET", url: `/api/link-favicon?url=${encodeURIComponent(url)}` })).statusCode).toBe(400);
    }
    expect(linkFaviconLoader).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

class MockAdapter implements Adapter {
  id = "codex";
  displayName = "Mock Codex";
  readonly seeds: SeedOptions[] = [];
  readonly continues: ContinueOptions[] = [];
  abortedSeeds = 0;
  mode: "normal" | "hang" | "boundary" | "resume_compaction_fail" | "material_compaction_fail" = "normal";
  responseText = "done";
  beforeResponse?: (opts: SeedOptions) => Promise<void>;
  failuresRemaining = 0;
  failNextTurn = false;
  failureAfterBeforeResponse?: string;
  turnUsage?: { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number };

  listModels(): ModelOption[] {
    return [{ id: "mock-model", label: "Mock Model" }];
  }

  listEfforts(): EffortOption[] {
    return [{ id: "high", label: "High" }];
  }

  apiPriceProfile(): ApiPriceProfile {
    return {
      id: "mock-model", pricingModel: "mock-model", catalogVersion: "test", effectiveAt: "2026-01-01",
      sourceUrl: "https://example.test/pricing", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1,
      cacheWriteInputUsdPerMillion: 1.25, outputUsdPerMillion: 5,
    };
  }

  async *seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    this.seeds.push(opts);
    yield { type: "session", sessionId: "sess-1" };
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      yield { type: "error", message: "simulated runtime failure" };
      return;
    }
    if (this.failNextTurn) {
      this.failNextTurn = false;
      yield { type: "error", message: "transient runtime failure" };
      yield { type: "turn_done" };
      return;
    }
    if (this.mode === "hang") {
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      this.abortedSeeds += 1;
      yield { type: "error", message: "run cancelled" };
      return;
    }
    if (this.mode === "boundary") {
      // Leave a real safe-boundary window after a tool event. Collaboration
      // notifications must queue here rather than alter the in-flight turn.
      yield { type: "command", command: "long-running-tool", cwd: opts.cwd };
      await sleep(40);
    }
    const beforeResponse = this.beforeResponse;
    this.beforeResponse = undefined;
    if (beforeResponse) await beforeResponse(opts);
    if (this.failureAfterBeforeResponse) {
      const message = this.failureAfterBeforeResponse;
      this.failureAfterBeforeResponse = undefined;
      yield { type: "error", message };
      return;
    }
    await sleep(5);
    yield { type: "command", command: "pnpm test", cwd: opts.cwd };
    yield { type: "file_change", path: "a.ts", kind: "edit", diff: "diff --git a/a.ts b/a.ts\n" };
    yield { type: "text", delta: this.responseText };
    yield { type: "turn_done", ...(this.turnUsage ? { usage: this.turnUsage } : {}) };
  }

  async *continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    this.continues.push(opts);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      yield { type: "error", message: "simulated runtime failure" };
      return;
    }
    if (this.mode === "resume_compaction_fail") {
      yield { type: "session", sessionId: opts.resumeSessionId };
      yield {
        type: "error",
        message: "codex exited with code 1: Failed to run pre-sampling compact",
      };
      return;
    }
    if (this.mode === "material_compaction_fail") {
      yield { type: "session", sessionId: opts.resumeSessionId };
      yield { type: "command", command: "touch already-ran", cwd: opts.cwd };
      yield { type: "error", message: "codex exited with code 1: Failed to run pre-sampling compact" };
      return;
    }
    if (this.failNextTurn) {
      this.failNextTurn = false;
      yield { type: "error", message: "transient runtime failure" };
      yield { type: "turn_done" };
      return;
    }
    yield { type: "text", delta: `continued ${opts.resumeSessionId}` };
    yield { type: "turn_done" };
  }
}

class TestEventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = [];
  private waiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;
  push(value: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }
  close(): void {
    this.closed = true;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return { next: () => {
      const value = this.values.shift();
      return value ? Promise.resolve({ value, done: false })
        : this.closed ? Promise.resolve({ value: undefined, done: true })
        : new Promise((resolve) => this.waiters.push(resolve));
    } };
  }
}

class SteerableMockAdapter extends MockAdapter {
  readonly starts: RuntimeTurnInput[] = [];
  readonly steers: RuntimeTurnInput[] = [];
  readonly openedOptions: OpenRuntimeSessionOptions[] = [];
  readonly livenessSetters: Array<(alive: boolean) => void> = [];
  opened = 0;
  closed = 0;
  interrupted = 0;
  closeFailuresRemaining = 0;
  closeBarrier?: Promise<void>;
  openBarrier?: Promise<void>;
  openFailure?: Error;
  closeLeavesEventsOpen = false;
  failNextSteer = false;
  completeStartedTurns = false;
  completeSteers = true;
  onStartedTurn?: (turnNumber: number, environment: NonNullable<OpenRuntimeSessionOptions["environment"]>) => Promise<void>;
  readonly queues: TestEventQueue[] = [];

  crashRoot(sessionIndex: number): void {
    this.openedOptions[sessionIndex]?.onRuntimeRootExit();
  }

  markDead(sessionIndex: number): void {
    this.livenessSetters[sessionIndex]?.(false);
  }

  completeTurn(sessionIndex: number): void {
    this.queues[sessionIndex]?.push({ type: "turn_done" });
  }

  closeEventStream(sessionIndex: number): void {
    this.queues[sessionIndex]?.close();
  }

  async openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.opened += 1;
    this.openedOptions.push(opts);
    const queue = new TestEventQueue();
    this.queues.push(queue);
    queue.push({ type: "session", sessionId: "persistent-session" });
    let alive = true;
    this.livenessSetters.push((next) => { alive = next; });
    let closePromise: Promise<void> | undefined;
    const session: RuntimeSession = {
      engineAgentId: "persistent-session",
      events: queue,
      isAlive: () => alive,
      startTurn: async (input) => {
        this.starts.push(input);
        if (this.completeStartedTurns) {
          await this.onStartedTurn?.(this.starts.length, opts.environment ?? {});
          queue.push({ type: "turn_done" });
        }
        return { turnId: "persistent-turn" };
      },
      steer: async (input) => {
        this.steers.push(input);
        if (this.failNextSteer) {
          this.failNextSteer = false;
          throw new Error("steering transport closed after submission");
        }
        if (this.completeSteers) {
          queue.push({ type: "text", delta: "steered result" });
          queue.push({ type: "turn_done" });
        }
        return { status: "accepted", turnId: "persistent-turn" };
      },
      interrupt: async () => { this.interrupted += 1; },
      close: () => {
        if (closePromise) return closePromise;
        this.closed += 1;
        const attempt = (async () => {
          await this.closeBarrier;
          if (this.closeFailuresRemaining > 0) {
            this.closeFailuresRemaining -= 1;
            throw new Error("simulated provider close failure");
          }
          alive = false;
          if (!this.closeLeavesEventsOpen) queue.close();
        })();
        closePromise = attempt.catch((error) => {
          closePromise = undefined;
          throw error;
        });
        return closePromise;
      },
    };
    opts.onRuntimeSpawned?.(session);
    await this.openBarrier;
    if (this.openFailure) throw this.openFailure;
    return session;
  }
}

function stubbornProcessAdapter(children: ChildProcess[], killGraceMs = 80): Adapter {
  const fake = fileURLToPath(new URL("../../../packages/engines/test/fake-claude-stream.mjs", import.meta.url));
  const fallback = new MockAdapter();
  return {
    id: "codex",
    displayName: "Stubborn persistent runtime",
    listModels: () => fallback.listModels(),
    listEfforts: () => fallback.listEfforts(),
    apiPriceProfile: () => fallback.apiPriceProfile(),
    seed: (opts) => fallback.seed(opts),
    continue: (opts) => fallback.continue(opts),
    openSession: async (opts) => new ClaudeStreamSession({
      ...opts,
      bin: "claude",
      permissionMode: "bypassPermissions",
      killGraceMs,
      environment: { ...opts.environment, PONDEROSA_TEST_IGNORE_SIGTERM: "1" },
      spawnFn: ((_bin: string, _args: readonly string[], spawnOptions: object) => {
        const child = spawn(process.execPath, [fake], spawnOptions);
        children.push(child);
        return child;
      }) as unknown as typeof spawn,
    }),
  };
}

function stubbornOneShotAdapter(children: ChildProcess[], pidFile: string, killGraceMs = 120): Adapter {
  const fake = fileURLToPath(new URL("../../../packages/engines/test/fake-stubborn-run.mjs", import.meta.url));
  const fallback = new MockAdapter();
  const execute = (opts: SeedOptions | ContinueOptions): AsyncIterable<AgentEvent> => streamProcess({
    bin: process.execPath,
    args: [fake],
    cwd: opts.cwd,
    signal: opts.signal,
    onRuntimeSpawned: opts.onRuntimeSpawned,
    onRuntimeRootExit: opts.onRuntimeRootExit,
    environment: { ...opts.environment, PONDEROSA_TEST_DESCENDANT_PID_FILE: pidFile },
    killGraceMs,
    label: "stubborn one-shot",
    spawnFn: ((_bin: string, _args: readonly string[], spawnOptions: object) => {
      const child = spawn(process.execPath, [fake], spawnOptions);
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
    map: (raw) => (raw as { type?: string }).type === "ready"
      ? [{ type: "session", sessionId: "stubborn-one-shot" }]
      : [],
  });
  return {
    id: "codex",
    displayName: "Stubborn one-shot runtime",
    listModels: () => fallback.listModels(),
    listEfforts: () => fallback.listEfforts(),
    apiPriceProfile: () => fallback.apiPriceProfile(),
    seed: execute,
    continue: execute,
  };
}

let dataDir: string;
let repoDir: string;
let store: AgentStore;
let adapter: MockAdapter;
let engines: EngineRegistration[];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-server-data-"));
  repoDir = mkdtempSync(path.join(tmpdir(), "pond-server-repo-"));
  process.env.PONDEROSA_BROWSE_ROOTS = repoDir;
  writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  store = new AgentStore(dataDir);
  adapter = new MockAdapter();
  engines = [{ adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
});

afterEach(() => {
  delete process.env.PONDEROSA_BROWSE_ROOTS;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

async function createProjectAndAgent() {
  const app = createServer({ dataDir, store, engines, logger: false });
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
  });
  const project = projectRes.json<{ id: string }>();
  const agentRes = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/agents`,
    payload: { title: "Agent", engine: "codex" },
  });
  const agent = agentRes.json<{ id: string }>();
  return { app, project, agent };
}

describe("notification panel actions", () => {
  it("marks every notification read and clears them through canonical workspace events", async () => {
    const project = store.createProject({ label: "Notifications", hostPath: repoDir, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Release chat" });
    const workspace = new WorkspaceStore(dataDir);
    workspace.createNotification({ projectId: project.id, conversationId: conversation.id, communicationEventId: "message-one", kind: "mentions", title: "Agent", body: "Review this" });
    workspace.createNotification({ projectId: project.id, conversationId: conversation.id, communicationEventId: "message-two", kind: "direct_responses", title: "Agent", body: "Done" });
    const app = createServer({ dataDir, store, engines, logger: false });

    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "POST", url: "/api/notifications/read" })).json()).toEqual({ read: 2 });
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ readAt?: string }>>().every((item) => Boolean(item.readAt))).toBe(true);
    expect((await app.inject({ method: "DELETE", url: "/api/notifications" })).json()).toEqual({ cleared: 2 });
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json()).toEqual([]);
    await app.close();
  });
});

describe("Agent work inspector", () => {
  it("returns a scoped read-only trace projection with Decisions", async () => {
    const project = store.createProject({ label: "Inspector", hostPath: repoDir, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Work room" });
    const otherConversation = store.createConversation(project.id, { title: "Other room" });
    const otherProject = store.createProject({ label: "Other inspector", hostPath: repoDir, defaultEngine: "codex" });
    const agent = store.createAgent(project.id, { title: "Coordinator", engine: "codex", conversationId: conversation.id });
    const workspace = new WorkspaceStore(dataDir);
    const decision = workspace.createDecision({
      projectId: project.id, conversationId: conversation.id, agentId: agent.id, runId: "execution-one",
      mode: "approval", question: "Proceed with the inspected work? ".repeat(80), options: [{ id: "yes", label: "Proceed" }],
      allowOther: true, blocking: true, idempotencyKey: "inspector-decision",
    });
    const app = createServer({ dataDir, store, engines, logger: false });

    const response = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-work?conversationId=${conversation.id}&agentId=${agent.id}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: project.id, conversationId: conversation.id, agentId: agent.id,
      agents: [{ id: agent.id, title: "Coordinator" }],
      items: [expect.objectContaining({ id: `decision:${decision.id}`, kind: "decision", state: "pending" })],
      traces: [expect.objectContaining({ state: "active", itemIds: [`decision:${decision.id}`] })],
    });
    expect(response.json<{ items: Array<{ details?: unknown }> }>().items[0]?.details).toBeUndefined();
    const details = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work/items/decision/${decision.id}?conversationId=${conversation.id}`,
    });
    expect(details.statusCode, details.body).toBe(200);
    expect(details.json()).toMatchObject({
      projectId: project.id,
      itemId: `decision:${decision.id}`,
      details: expect.arrayContaining([{ label: "Decision ID", value: decision.id }]),
    });
    const compressed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work?conversationId=${conversation.id}&agentId=${agent.id}`,
      headers: { "accept-encoding": "gzip" },
    });
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(compressed.rawPayload).toString())).toMatchObject({ projectId: project.id });
    const excludedGzip = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work?conversationId=${conversation.id}&agentId=${agent.id}`,
      headers: { "accept-encoding": "gzip;q=0, *;q=1" },
    });
    expect(excludedGzip.headers["content-encoding"]).toBeUndefined();
    expect(excludedGzip.json()).toMatchObject({ projectId: project.id });
    expect((await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work/items/decision/${decision.id}?conversationId=${otherConversation.id}`,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: `/api/projects/${otherProject.id}/agent-work/items/decision/${decision.id}`,
    })).statusCode).toBe(404);
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.coordinate({
      projectId: project.id, conversationId: conversation.id, requesterAgentId: agent.id,
      actorScope: `agent:${agent.id}`, idempotencyKey: "inspector-request",
      requests: [{ requestId: "inspector-request", recipientAgentId: agent.id, lifetime: { kind: "indefinite" }, payload: { assignment: "Inspect" } }],
      join: { id: "inspector-join", mode: "all" },
    });
    const requestDetails = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work/items/request/inspector-request?conversationId=${conversation.id}`,
    });
    expect(requestDetails.statusCode, requestDetails.body).toBe(200);
    expect(requestDetails.json()).toMatchObject({
      itemId: "request:inspector-request",
      details: expect.arrayContaining([{ label: "Payload", value: '{"assignment":"Inspect"}' }]),
    });
    const joinDetails = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work/items/join/inspector-join?conversationId=${conversation.id}`,
    });
    expect(joinDetails.statusCode, joinDetails.body).toBe(200);
    expect(joinDetails.json()).toMatchObject({
      itemId: "join:inspector-join",
      details: expect.arrayContaining([{ label: "Wake policy", value: "Final only" }]),
    });
    const withSelfRequest = (await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work?conversationId=${conversation.id}&agentId=${agent.id}`,
    })).json<{ items: Array<{ id: string; title: string }> }>();
    expect(withSelfRequest.items.find((item) => item.id === "request:inspector-request")?.title)
      .toBe("Coordinator asked Coordinator to work");
    expect((await app.inject({ method: "POST", url: `/api/decisions/${decision.id}/respond`, payload: { optionId: "yes" } })).statusCode).toBe(200);
    const afterResponse = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-work?conversationId=${conversation.id}&agentId=${agent.id}` })).json<{
      items: Array<{ id: string; kind: string; referenceIds: string[]; relatedItemIds: string[] }>;
      traces: Array<{ itemIds: string[] }>;
    }>();
    const responseActivation = afterResponse.items.find((item) => item.kind === "activation" && item.referenceIds.includes(`decision:${decision.id}:response`))!;
    expect(afterResponse.items.find((item) => item.id === `decision:${decision.id}`)?.relatedItemIds).toContain(responseActivation.id);
    expect(afterResponse.traces.some((trace) => trace.itemIds.includes(`decision:${decision.id}`) && trace.itemIds.includes(responseActivation.id))).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-work?conversationId=foreign` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-work?limit=0` })).statusCode).toBe(400);
    await app.close();
  });
});

async function waitForRun(agentId: string, expectedTurnDoneCount = 1): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const done = store.readEvents(agentId).filter((event) => event.event.type === "turn_done").length;
    if (done >= expectedTurnDoneCount) return;
    await sleep(10);
  }
  throw new Error("run did not finish");
}

async function waitForSeedCount(expected: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (adapter.seeds.length >= expected) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${expected} seeded runs`);
}

describe("generated artifact endpoints", () => {
  it("previews and downloads bounded project files without escaping the registered workspace", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Project file browser", hostPath: repoDir });
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(path.join(repoDir, "concept.png"), png);
    writeFileSync(path.join(repoDir, "notes.md"), "# Notes\n");

    const preview = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/preview?path=${encodeURIComponent("concept.png")}`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers["content-type"]).toContain("image/png");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.rawPayload).toEqual(png);

    const unsupportedPreview = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/preview?path=${encodeURIComponent("notes.md")}`,
    });
    expect(unsupportedPreview.statusCode).toBe(415);
    writeFileSync(path.join(repoDir, "fake.png"), "not really a png");
    expect((await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/preview?path=${encodeURIComponent("fake.png")}`,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/preview?path=${encodeURIComponent("../outside.png")}`,
    })).statusCode).toBe(404);

    const download = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/download?path=${encodeURIComponent("notes.md")}`,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body).toBe("# Notes\n");
    await app.close();
  });

  it("rejects a Project-file replacement race after resolution", async () => {
    const project = store.createProject({ label: "Project file replacement", hostPath: repoDir });
    const candidate = path.join(repoDir, "replace.png");
    const outside = path.join(dataDir, "outside.png");
    writeFileSync(candidate, Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(outside, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("private")]));
    let replaced = false;
    const app = createServer({
      dataDir, store, engines, logger: false,
      projectFilePreviewFaults: {
        afterResolve: (resolved) => {
          if (replaced || resolved !== candidate) return;
          replaced = true;
          rmSync(candidate);
          symlinkSync(outside, candidate);
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/preview?path=${encodeURIComponent("replace.png")}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.rawPayload).not.toContain(Buffer.from("private"));
    await app.close();
  });

  it("bounds concurrent Project-file previews per Project", async () => {
    const project = store.createProject({ label: "Project preview concurrency", hostPath: repoDir });
    writeFileSync(path.join(repoDir, "concept.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const app = createServer({
      dataDir, store, engines, logger: false,
      projectFilePreviewFaults: { afterResolve: async () => { entered += 1; await barrier; } },
    });
    const url = `/api/projects/${project.id}/workspace-files/preview?path=${encodeURIComponent("concept.png")}`;
    const active = Array.from({ length: 4 }, () => app.inject({ method: "GET", url }));
    await vi.waitFor(() => expect(entered).toBe(4));
    const saturated = await app.inject({ method: "GET", url });
    expect(saturated.statusCode).toBe(429);
    expect(saturated.headers["retry-after"]).toBe("1");
    release();
    expect((await Promise.all(active)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    await app.close();
  });

  it("does not account nonexistent Projects and shares weighted capacity with downloads", async () => {
    writeFileSync(path.join(repoDir, "download.txt"), "bounded transfer\n");
    const projects = Array.from({ length: 4 }, (_, index) => store.createProject({
      label: `Transfer ${index}`,
      hostPath: repoDir,
    }));
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const app = createServer({
      dataDir, store, engines, logger: false,
      projectFilePreviewFaults: { afterResolve: async () => { entered += 1; await barrier; } },
    });
    for (let index = 0; index < 600; index += 1) {
      const missing = await app.inject({
        method: "GET",
        url: `/api/projects/missing-${index}/workspace-files/download?path=download.txt`,
      });
      expect(missing.statusCode).toBe(404);
    }
    const active = projects.slice(0, 3).flatMap((project) => Array.from({ length: 2 }, () => app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/workspace-files/download?path=download.txt`,
    })));
    await vi.waitFor(() => expect(entered).toBe(6));
    const saturated = await app.inject({
      method: "GET",
      url: `/api/projects/${projects[3]!.id}/workspace-files/download?path=download.txt`,
    });
    expect(saturated.statusCode).toBe(429);
    release();
    expect((await Promise.all(active)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    const recovered = await app.inject({
      method: "GET",
      url: `/api/projects/${projects[3]!.id}/workspace-files/download?path=download.txt`,
    });
    expect(recovered.statusCode).toBe(200);
    await app.close();
  });

  it("authorizes artifact references submitted through history and retained by the accepted provider session", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Historical artifact roots", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, { title: "Reader", engine: "codex", conversationId: conversation.id });
    const fullText = `HISTORICAL-START\n${"h".repeat(100_000)}\nHISTORICAL-END`;
    const broadcast = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: fullText, idempotencyKey: "historical-large-message" },
    });
    expect(broadcast.statusCode, broadcast.body).toBe(200);
    const communication = store.getCommunicationEvent(
      project.id,
      broadcast.json<{ communicationEventId: string }>().communicationEventId,
    )!;
    const artifactId = communication.document?.artifactId;
    expect(artifactId).toMatch(/^text-/);
    if (!artifactId) throw new Error("expected historical artifact id");

    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Read the historical document", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const firstRun = store.getRuns(agent.id)[0]!;
    const firstInput = store.getProviderInput(firstRun.id, true)!;
    expect(firstInput.exactPrompt).toContain(`ponderosa://artifact/${artifactId}`);
    expect(firstInput.sourceManifest.artifactIds).toContain(artifactId);
    expect(firstInput.sourceManifest.sources).toContainEqual({
      kind: "artifact", ref: artifactId, delivery: "submitted",
    });
    const firstRetrieval = await persistent.openedOptions[0]!.handleDynamicToolCall!({
      name: "ponderosa_result",
      arguments: { refs: [`ponderosa://artifact/${artifactId}`], maxBytes: 262_144 },
    });
    expect(firstRetrieval.success, firstRetrieval.text).toBe(true);
    expect(JSON.parse(firstRetrieval.text)).toMatchObject({
      items: [{ complete: true, content: fullText }],
    });
    persistent.completeTurn(0);
    await vi.waitFor(() => expect(store.resumeSessionState(agent.id)).toMatchObject({
      sessionId: "persistent-session",
      toolContractHash: PROVIDER_TOOL_CONTRACT_HASH,
      artifactIds: expect.arrayContaining([artifactId]),
    }));

    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Retrieve it again from retained context", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(2));
    expect(persistent.openedOptions.at(-1)?.resumeSessionId).toBe("persistent-session");
    const secondRun = store.getRuns(agent.id)[1]!;
    const secondInput = store.getProviderInput(secondRun.id, true)!;
    expect(secondInput.sourceManifest.artifactIds).toContain(artifactId);
    expect(secondInput.sourceManifest.sources).toContainEqual({
      kind: "artifact", ref: artifactId, delivery: "retained_session",
    });
    const retainedRetrieval = await persistent.openedOptions.at(-1)!.handleDynamicToolCall!({
      name: "ponderosa_result",
      arguments: { refs: [`ponderosa://artifact/${artifactId}`], maxBytes: 262_144 },
    });
    expect(retainedRetrieval.success, retainedRetrieval.text).toBe(true);
    expect(JSON.parse(retainedRetrieval.text)).toMatchObject({
      items: [{ complete: true, content: fullText }],
    });
    persistent.completeTurn(0);
    await app.close();
  });

  it("backs text above 10,000 Unicode code points with one durable user artifact", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 2, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Long text", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const inlineAgent = store.createAgent(project.id, { title: "Inline", engine: "codex", conversationId: conversation.id });
    const longAgent = store.createAgent(project.id, { title: "Long", engine: "codex", conversationId: conversation.id });

    const boundary = "😀".repeat(10_000);
    const inline = await app.inject({
      method: "POST", url: `/api/agents/${inlineAgent.id}/messages`,
      payload: { text: boundary, sourceChannel: "main", sourceConversationId: conversation.id },
    });
    expect(inline.statusCode, inline.body).toBe(202);
    const inlineEvent = store.readCommunicationEvents(project.id).find((event) => event.sender.kind === "user" && event.text === boundary);
    expect(inlineEvent?.document).toBeUndefined();

    const fullText = "😀".repeat(10_001);
    const submitted = await app.inject({
      method: "POST", url: `/api/agents/${longAgent.id}/messages`,
      payload: {
        text: fullText,
        idempotencyKey: "long-user-message",
        sourceChannel: "main",
        sourceConversationId: conversation.id,
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const submittedBody = submitted.json<{ activationId: string; communicationEventId: string }>();
    const event = store.getCommunicationEvent(project.id, submittedBody.communicationEventId)!;
    expect(event.text).toMatch(/^Full message: ponderosa:\/\/artifact\/text-/);
    expect(event.text).not.toContain(fullText);
    expect(event.document).toMatchObject({
      id: expect.stringMatching(/^text-/),
      artifactId: expect.stringMatching(/^text-/),
      title: "Pasted text",
      authorUserId: "local-operator",
      byteLength: Buffer.byteLength(fullText, "utf8"),
    });
    expect(event.document).not.toHaveProperty("content");
    const artifactId = event.document!.artifactId!;
    expect(readFileSync(managedArtifactContentPath(dataDir, project.id, artifactId), "utf8")).toBe(fullText);
    expect(store.getProjectArtifact(project.id, artifactId)).toMatchObject({ id: artifactId, visibility: "project" });
    const runtimeRow = store.sqlite.prepare(`
      SELECT payload_json FROM runtime_communications WHERE id = ?
    `).get(`dispatch:${submittedBody.communicationEventId}:${longAgent.id}`) as { payload_json: string };
    expect(runtimeRow.payload_json).toContain(`ponderosa://artifact/${artifactId}`);
    expect(runtimeRow.payload_json).not.toContain(fullText);
    const retried = await app.inject({
      method: "POST", url: `/api/agents/${longAgent.id}/messages`,
      payload: {
        text: fullText,
        idempotencyKey: "long-user-message",
        sourceChannel: "main",
        sourceConversationId: conversation.id,
      },
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json()).toMatchObject({ communicationEventId: submittedBody.communicationEventId });
    expect(store.getConversationMessages(conversation.id, "main")
      .filter((message) => message.communicationEventId === submittedBody.communicationEventId)).toHaveLength(1);
    expect(new CoordinationV3Store(store.sqlite).runtimeArtifacts("communication", `dispatch:${submittedBody.communicationEventId}:${longAgent.id}`)).toHaveLength(1);

    await vi.waitFor(() => expect(persistent.openedOptions.some((options) => options.agentId === longAgent.id)).toBe(true));
    const sessionIndex = persistent.openedOptions.findIndex((options) => options.agentId === longAgent.id);
    const runtime = persistent.openedOptions[sessionIndex]!;
    const started = persistent.starts[sessionIndex]!;
    expect(started.prompt).toContain(`ponderosa://artifact/${artifactId}`);
    expect(started.prompt).not.toContain(fullText);
    const countsBefore = store.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM scheduler_runs) AS runs,
      (SELECT COUNT(*) FROM agent_activations) AS activations`).get();
    const retrieved = await runtime.handleDynamicToolCall!({
      name: "ponderosa_result",
      arguments: { refs: [`ponderosa://artifact/${artifactId}`], maxBytes: 262_144 },
    });
    expect(retrieved.success, retrieved.text).toBe(true);
    expect(JSON.parse(retrieved.text)).toMatchObject({
      items: [{ ref: `ponderosa://artifact/${artifactId}`, complete: true, content: fullText }],
    });
    expect(store.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM scheduler_runs) AS runs,
      (SELECT COUNT(*) FROM agent_activations) AS activations`).get()).toEqual(countsBefore);
    for (let index = 0; index < persistent.openedOptions.length; index += 1) persistent.completeTurn(index);
    await app.close();
  });

  it("uses the same artifact-backed long-text contract on every shared composer route", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Shared long text", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: conversation.id });
    const second = store.createAgent(project.id, {
      title: "Second", engine: "codex", conversationId: conversation.id, managerAgentId: first.id,
    });
    const fullText = `Shared body\n${"z".repeat(10_100)}`;
    const eventIds: string[] = [];

    const broadcast = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: fullText, idempotencyKey: "long-broadcast" },
    });
    expect(broadcast.statusCode, broadcast.body).toBe(200);
    eventIds.push(broadcast.json<{ communicationEventId: string }>().communicationEventId);

    const direct = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/direct-messages`,
      payload: {
        text: fullText,
        recipients: [{ agentId: first.id }, { agentId: second.id }],
        idempotencyKey: "long-direct",
      },
    });
    expect(direct.statusCode, direct.body).toBe(200);
    eventIds.push(direct.json<{ messageId: string }>().messageId);

    const collaboration = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/collaboration/messages`,
      payload: { text: fullText, recipientAgentIds: [first.id], idempotencyKey: "long-collaboration" },
    });
    expect(collaboration.statusCode, collaboration.body).toBe(200);
    eventIds.push(collaboration.json<{ message: { communicationEventId: string } }>().message.communicationEventId);

    const authored = appendCanonicalMessage(
      store, project.id, conversation.id, { role: "assistant", text: "Reply here" }, first.id,
    )!;
    const directReply = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/direct-replies`,
      payload: {
        text: fullText,
        replyToMessageId: authored.id,
        targetAuthorAgentId: first.id,
        idempotencyKey: "long-direct-reply",
      },
    });
    expect(directReply.statusCode, directReply.body).toBe(200);
    eventIds.push(directReply.json<{ messageId: string }>().messageId);

    const created = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: { title: "New reader", engine: "codex", conversationId: conversation.id, initialMessage: fullText },
    });
    expect(created.statusCode, created.body).toBe(200);
    eventIds.push(`agent-opening:${created.json<{ id: string }>().id}`);

    expect(new Set(eventIds).size).toBe(5);
    for (const eventId of eventIds) {
      const event = store.getCommunicationEvent(project.id, eventId)!;
      expect(event.text).toMatch(/^Full message: ponderosa:\/\/artifact\/text-/);
      expect(event.text).not.toContain(fullText);
      expect(event.document).toMatchObject({
        artifactId: expect.stringMatching(/^text-/),
        authorUserId: "local-operator",
        byteLength: Buffer.byteLength(fullText, "utf8"),
      });
      expect(readFileSync(managedArtifactContentPath(dataDir, project.id, event.document!.artifactId!), "utf8")).toBe(fullText);
    }
    expect(new CoordinationV3Store(store.sqlite).runtimeArtifacts()
      .filter((artifact) => artifact.projectId === project.id)).toHaveLength(5);
    const directArtifactId = store.getCommunicationEvent(project.id, eventIds[1]!)!.document!.artifactId!;
    const exported = (await app.inject({
      method: "GET", url: `/api/agents/${first.id}/export?mode=full&organization=true`,
    })).json<import("@ponderosa/core").AgentPortablePackageDto>();
    const exportedArtifactRefs = exported.agents.flatMap((agent) => agent.artifacts ?? []).map((artifact) => artifact.ref);
    expect(exportedArtifactRefs).toContain(directArtifactId);
    expect(new Set(exportedArtifactRefs).size).toBe(exportedArtifactRefs.length);
    await app.close();
  });

  it("recovers a user artifact and canonical message after restart between SQLite commit and projection", async () => {
    const project = store.createProject({ label: "Restart artifact", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, { title: "Reader", engine: "codex", conversationId: conversation.id });
    let crash = true;
    const first = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1 },
      messageLifecycleFaults: {
        afterCommunicationArtifactCommit: () => {
          if (crash) {
            crash = false;
            throw new Error("simulated process crash before projection");
          }
        },
      },
    });
    await first.ready();
    await first.inject({ method: "POST", url: "/api/deployment/drain" });
    const response = await first.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "u".repeat(10_100), sourceChannel: "main", sourceConversationId: conversation.id },
    });
    expect(response.statusCode).toBe(500);
    const artifact = new CoordinationV3Store(store.sqlite).runtimeArtifacts("communication")[0]!;
    expect(readFileSync(managedArtifactContentPath(dataDir, project.id, artifact.id), "utf8")).toBe("u".repeat(10_100));
    expect(store.readCommunicationEvents(project.id)).toHaveLength(0);
    await first.close();

    store = new AgentStore(dataDir);
    const restarted = createServer({ dataDir, store, engines, logger: false });
    await restarted.ready();
    expect(store.getProjectArtifact(project.id, artifact.id)).toMatchObject({ id: artifact.id });
    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      eventId: expect.any(String),
      text: `Full message: ponderosa://artifact/${artifact.id}`,
      document: expect.objectContaining({ artifactId: artifact.id, authorUserId: "local-operator" }),
    }));
    await restarted.close();
  });

  it("previews and downloads a canonical PDF only inside its owning project", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const pdf = Buffer.from("%PDF-1.4\n% test\n");
    const pdfPath = path.join(repoDir, "report.pdf");
    writeFileSync(pdfPath, pdf);
    store.appendEvent(agent.id, { type: "file_change", path: pdfPath, kind: "create" });
    const artifact = store.getArtifacts(agent.id).find((item) => item.kind === "document")!;

    expect(artifact).toMatchObject({ mediaType: "application/pdf", previewUrl: expect.any(String), downloadUrl: expect.any(String) });
    const preview = await app.inject({ method: "GET", url: artifact.previewUrl! });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.rawPayload).toEqual(pdf);

    const download = await app.inject({ method: "GET", url: artifact.downloadUrl! });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    const foreign = artifact.previewUrl!.replace(`/projects/${project.id}/`, "/projects/not-the-owner/");
    expect((await app.inject({ method: "GET", url: foreign })).statusCode).toBe(404);
    await app.close();
  });
});

describe("human-facing chat projection boundary", () => {
  it("keeps execution details out of the Agent chat source used for transcripts", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const communicationEventId = randomUUID();
    store.appendCommunicationEvent({
      eventId: communicationEventId,
      schemaVersion: 2,
      projectId: project.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Human-facing request",
      createdAt: new Date().toISOString(),
    });
    store.appendEvent(agent.id, { type: "user_message", text: "Human-facing request", communicationEventId });
    store.appendEvent(agent.id, { type: "command", command: "secret-command --flag", cwd: repoDir });
    store.appendEvent(agent.id, {
      type: "agent_output",
      executionId: "execution-1",
      text: "Ordinary work-log output",
      sourceSeqStart: 2,
      sourceSeqEnd: 3,
    });
    store.appendEvent(agent.id, { type: "file_change", path: "src/private.ts", kind: "edit", diff: "+private diff" });

    const response = await app.inject({ method: "GET", url: `/api/agents/${agent.id}` });
    expect(response.statusCode).toBe(200);
    const detail = response.json<{ messages: Array<{ text: string }>; runOutput: Array<{ text: string }>; activity: unknown[]; changedFiles: unknown[] }>();
    expect(detail.messages).toEqual([expect.objectContaining({ text: "Human-facing request" })]);
    expect(JSON.stringify(detail.messages)).not.toContain("secret-command");
    expect(JSON.stringify(detail.messages)).not.toContain("private diff");
    expect(JSON.stringify(detail.messages)).not.toContain("Ordinary work-log output");
    expect(detail.runOutput).toEqual([expect.objectContaining({ text: "Ordinary work-log output" })]);
    expect(detail.activity.length).toBeGreaterThan(0);
    expect(detail.changedFiles.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("interactive browser API", () => {
  const trackedBrowserDriver = (): BrowserDriver => ({
    pageInfo: async () => ({ url: "about:blank", title: "Blank" }),
    navigate: async (url) => ({ url, title: "Page" }),
    inspect: async () => JSON.stringify({ url: "about:blank", controls: [] }),
    click: async () => ({ url: "about:blank", title: "Blank" }),
    fill: async () => ({ url: "about:blank", title: "Blank" }),
    key: async () => ({ url: "about:blank", title: "Blank" }),
    pointer: async () => ({ url: "about:blank", title: "Blank" }),
    type: async () => ({ url: "about:blank", title: "Blank" }),
    scroll: async () => ({ url: "about:blank", title: "Blank" }),
    capture: async () => Buffer.from("89504e470d0a1a0a", "hex"),
    close: vi.fn(async () => undefined),
  });

  const startBrowserRun = async (app: ReturnType<typeof createServer>, headers?: Record<string, string>) => {
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers,
      payload: { label: "Browser lifecycle", hostPath: repoDir, defaultEngine: "codex" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`, headers,
      payload: { title: "Browser lifecycle agent", engine: "codex" },
    })).json<{ id: string }>();
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, headers, payload: { text: "Use the browser" },
    })).statusCode).toBe(202);
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("running");
    await waitForSeedCount(1);
    const runId = store.getRuns(agent.id)[0]!.id;
    const browserUrl = `/api/projects/${project.id}/agents/${agent.id}/runs/${runId}/browser`;
    expect((await app.inject({ method: "POST", url: browserUrl, headers })).statusCode).toBe(200);
    return { project, agent, runId, browserUrl };
  };

  it("authorizes operator DELETE against the exact run and tears down its session", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({
      dataDir, store, engines, logger: false, authToken: "operator-secret",
      browserDriverFactory: async () => driver,
    });
    const operator = { authorization: "Bearer operator-secret" };
    const { agent, runId, browserUrl } = await startBrowserRun(app, operator);

    expect((await app.inject({ method: "DELETE", url: browserUrl })).statusCode).toBe(401);
    expect((await app.inject({
      method: "DELETE", url: browserUrl.replace(runId, "foreign-run"), headers: operator,
    })).statusCode).toBe(404);
    const closed = await app.inject({ method: "DELETE", url: browserUrl, headers: operator });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ projectId: expect.any(String), agentId: agent.id, runId, status: "closed" });
    expect(driver.close).toHaveBeenCalledTimes(1);
    expect(store.readEvents(agent.id)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: "browser_session", status: "closed", reason: "operator_closed", executionId: runId }),
    }));
    await app.close();
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("reserves a confirmed cascade while active browser cleanup blocks spawn and reparent races", async () => {
    adapter.mode = "hang";
    let releaseClose!: () => void;
    const closeBlocked = new Promise<void>((resolve) => { releaseClose = resolve; });
    const driver = trackedBrowserDriver();
    driver.close = vi.fn(async () => closeBlocked);
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    const { project, agent: manager } = await startBrowserRun(app);
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", managerAgentId: manager.id });
    const outside = store.createAgent(project.id, { title: "Outside", engine: "codex" });
    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`,
      payload: { rootAgentIds: [manager.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();

    const committing = app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    await expect.poll(() => vi.mocked(driver.close).mock.calls.length).toBe(1);
    const capability = adapter.seeds.at(-1)!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const lateToolCall = await app.inject({
      method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${capability}` },
    });
    const lateSpawn = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: { title: "Late child", engine: "codex", managerAgentId: manager.id },
    });
    const lateReparent = await app.inject({
      method: "PUT", url: `/api/agents/${child.id}/manager`, payload: { managerAgentId: outside.id },
    });
    const competingProjectDelete = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(lateToolCall.statusCode, lateToolCall.body).toBe(409);
    expect(lateSpawn.statusCode, lateSpawn.body).toBe(409);
    expect(lateReparent.statusCode, lateReparent.body).toBe(409);
    expect(competingProjectDelete.statusCode, competingProjectDelete.body).toBe(409);

    releaseClose();
    const committed = await committing;
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({
      deletedAgentIds: expect.arrayContaining([manager.id, child.id]),
    });
    expect(store.getAgent(outside.id)).toBeDefined();
    expect(store.listAgents(project.id).map((agent) => agent.id)).toEqual([outside.id]);
    await app.close();
  });

  it("authorizes run-capability close and tears down only its owned browser session", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    const { agent, runId } = await startBrowserRun(app);
    const capability = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;

    expect((await app.inject({
      method: "POST", url: "/api/agent-browser", headers: { authorization: "Bearer foreign-capability" },
      payload: { operation: "close" },
    })).statusCode).toBe(401);
    const closed = await app.inject({
      method: "POST", url: "/api/agent-browser", headers: { authorization: `Bearer ${capability}` },
      payload: { operation: "close" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ session: { agentId: agent.id, runId, status: "closed" } });
    expect(driver.close).toHaveBeenCalledTimes(1);
    expect(store.readEvents(agent.id)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: "browser_session", status: "closed", reason: "agent_closed", executionId: runId }),
    }));
    expect((await app.inject({
      method: "POST", url: "/api/agent-browser", headers: { authorization: `Bearer ${capability}` },
      payload: { operation: "inspect" },
    })).statusCode).toBe(409);
    await app.close();
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("authenticates and scopes operator/agent control to the exact active run", async () => {
    adapter.mode = "hang";
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const driver: BrowserDriver = {
      pageInfo: async () => ({ url: "about:blank", title: "Blank" }),
      navigate: async (url) => ({ url, title: "Page" }),
      inspect: async () => JSON.stringify({ url: "about:blank", controls: [] }),
      click: async () => ({ url: "about:blank", title: "Blank" }),
      fill: async () => ({ url: "about:blank", title: "Blank" }),
      key: async () => ({ url: "about:blank", title: "Blank" }),
      pointer: async () => ({ url: "about:blank", title: "Blank" }),
      type: async () => ({ url: "about:blank", title: "Blank" }),
      scroll: async () => ({ url: "about:blank", title: "Blank" }),
      capture: async () => png,
      close: async () => undefined,
    };
    const app = createServer({
      dataDir, store, engines, logger: false, authToken: "operator-secret",
      browserDriverFactory: async () => driver,
    });
    const operator = { authorization: "Bearer operator-secret" };
    const project = (await app.inject({
      method: "POST", url: "/api/projects", headers: operator,
      payload: { label: "Browser", hostPath: repoDir, defaultEngine: "codex" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`, headers: operator,
      payload: { title: "Browser agent", engine: "codex" },
    })).json<{ id: string }>();
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, headers: operator, payload: { text: "Open a browser" },
    })).statusCode).toBe(202);
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("running");
    await waitForSeedCount(1);
    const runId = store.getRuns(agent.id)[0]!.id;
    const root = `/api/projects/${project.id}/agents/${agent.id}/runs/${runId}/browser`;

    expect((await app.inject({ method: "POST", url: root })).statusCode).toBe(401);
    const opened = await app.inject({ method: "POST", url: root, headers: operator });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ projectId: project.id, agentId: agent.id, runId, status: "ready", controlOwner: "agent" });
    expect((await app.inject({ method: "GET", url: root.replace(runId, "foreign-run"), headers: operator })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: root.replace(project.id, "foreign-project"), headers: operator })).statusCode).toBe(404);

    const controlled = await app.inject({
      method: "PUT", url: `${root}/control`, headers: operator,
      payload: { owner: "operator", expectedControlEpoch: 1 },
    });
    expect(controlled.json()).toMatchObject({ controlOwner: "operator", controlEpoch: 2 });
    expect((await app.inject({
      method: "POST", url: `${root}/input`, headers: operator,
      payload: { kind: "click", x: 15, y: 20, expectedControlEpoch: 1 },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: `${root}/input`, headers: operator,
      payload: { kind: "click", x: 15, y: 20, expectedControlEpoch: 2 },
    })).statusCode).toBe(200);

    const environment = adapter.seeds[0]!.environment!;
    expect(environment.PONDEROSA_AGENT_BROWSER_URL).toMatch(/\/api\/agent-browser$/);
    const capabilityHeaders = { authorization: `Bearer ${environment.PONDEROSA_AGENT_MESSAGE_TOKEN}` };
    expect((await app.inject({ method: "POST", url: "/api/agent-browser", payload: { operation: "inspect" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/agent-browser", headers: capabilityHeaders, payload: { operation: "inspect" } })).statusCode).toBe(200);
    await app.inject({ method: "PUT", url: `${root}/control`, headers: operator, payload: { owner: "agent", expectedControlEpoch: 2 } });
    expect((await app.inject({ method: "POST", url: "/api/agent-browser", headers: capabilityHeaders, payload: { operation: "screenshot" } })).statusCode).toBe(200);
    const screenshot = store.getArtifacts(agent.id).find((artifact) => artifact.kind === "screenshot")!;
    expect(screenshot).toMatchObject({ mediaType: "image/png", previewUrl: expect.any(String) });
    expect((await app.inject({ method: "GET", url: screenshot.previewUrl!, headers: operator })).rawPayload).toEqual(png);

    await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`, headers: operator,
      payload: activeRunCancellationPayload(store, agent.id, "browser-stop"),
    });
    await expect.poll(async () => (await app.inject({ method: "GET", url: root, headers: operator })).statusCode).toBe(404);
    expect(store.readEvents(agent.id)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "browser_session", status: "closed" }) }));
    await app.close();
  });

  it("keeps a Project browser alive across Runs and lends it only to an exact active agent", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { label: "Persistent browser", hostPath: repoDir, defaultEngine: "codex" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Borrower", engine: "codex" },
    })).json<{ id: string }>();
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Inspect the shared browser" } })).statusCode).toBe(202);
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("running");
    await waitForSeedCount(1);
    const runId = store.getRuns(agent.id)[0]!.id;
    const capability = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const root = `/api/projects/${project.id}/browser`;

    const opened = await app.inject({ method: "POST", url: root, payload: { url: "https://example.com/start" } });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ projectId: project.id, status: "ready", controlOwner: "operator" });
    expect((await app.inject({ method: "PUT", url: `${root}/control`, payload: { owner: "agent", expectedControlEpoch: 1 } })).statusCode).toBe(409);
    const lent = await app.inject({
      method: "PUT", url: `${root}/control`, payload: { owner: "agent", agentId: agent.id, expectedControlEpoch: 1 },
    });
    expect(lent.json()).toMatchObject({ controlOwner: "agent", controllerAgentId: agent.id, controllerRunId: runId });

    const navigated = await app.inject({
      method: "POST", url: "/api/agent-browser", headers: { authorization: `Bearer ${capability}` },
      payload: { operation: "navigate", url: "https://example.com/borrowed" },
    });
    expect(navigated.statusCode).toBe(200);
    expect(navigated.json()).toMatchObject({ session: { projectId: project.id, url: "https://example.com/borrowed" } });

    await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: activeRunCancellationPayload(store, agent.id, "release-project-browser"),
    });
    await expect.poll(async () => (await app.inject({ method: "GET", url: root })).json().controlOwner).toBe("operator");
    const idempotentReclaim = await app.inject({
      method: "PUT", url: `${root}/control`, payload: { owner: "operator", expectedControlEpoch: 1 },
    });
    expect(idempotentReclaim.statusCode).toBe(200);
    expect(idempotentReclaim.json()).toMatchObject({ controlOwner: "operator" });
    expect(driver.close).not.toHaveBeenCalled();
    const afterRun = await app.inject({ method: "POST", url: `${root}/navigate`, payload: { url: "https://example.com/after-run" } });
    expect(afterRun.json()).toMatchObject({ status: "ready", controlOwner: "operator", url: "https://example.com/after-run" });

    expect((await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` })).statusCode).toBe(200);
    expect(driver.close).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    { terminal: "completed" as const, failure: undefined, reason: "run_completed" },
    { terminal: "failed" as const, failure: "browser owner failed", reason: "run_failed" },
  ])("tears down on normal $terminal run termination", async ({ terminal, failure, reason }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapter.beforeResponse = async () => gate;
    adapter.failureAfterBeforeResponse = failure;
    const driver = trackedBrowserDriver();
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    const { agent } = await startBrowserRun(app);

    release();
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe(terminal);
    await expect.poll(() => vi.mocked(driver.close).mock.calls.length).toBe(1);
    expect(store.readEvents(agent.id)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: "browser_session", status: "closed", reason }),
    }));
    await app.close();
  });

  it("tears down the browser when the owning execution lease expires", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({
      dataDir, store, engines, logger: false, browserDriverFactory: async () => driver,
      executionLeaseScheduling: { leaseMs: 80, heartbeatMs: 1_000 },
    });
    const { agent } = await startBrowserRun(app);

    await expect.poll(() => store.getRuns(agent.id)[0]?.status, { timeout: 2_000 }).toBe("failed");
    await expect.poll(() => vi.mocked(driver.close).mock.calls.length).toBe(1);
    expect(store.readEvents(agent.id)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ type: "browser_session", status: "closed", reason: "run_lease_expired" }),
    }));
    await app.close();
  });

  it("tears down the browser before deleting its owning project", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    const { project } = await startBrowserRun(app);

    expect((await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` })).statusCode).toBe(200);
    await expect.poll(() => vi.mocked(driver.close).mock.calls.length).toBe(1);
    await app.close();
  });

  it("quarantines a Project before bounded browser cleanup and permits a safe retry", async () => {
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const driver = trackedBrowserDriver();
    driver.close = vi.fn(() => closeBarrier);
    const app = createServer({
      dataDir, store, engines, logger: false,
      browserDriverFactory: async () => driver,
      projectDeletionCleanupTimeoutMs: 30,
    });
    const project = store.createProject({ label: "Quarantined browser", hostPath: repoDir });
    expect((await app.inject({ method: "POST", url: `/api/projects/${project.id}/browser` })).statusCode).toBe(200);

    const blocked = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(blocked.statusCode, blocked.body).toBe(503);
    expect(blocked.json()).toMatchObject({ cleanupPending: true, quarantined: true, retryable: true });
    expect(store.getProject(project.id)).toBeDefined();
    expect((await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: { title: "Must not start", engine: "codex" },
    })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/projects/${project.id}/browser` })).statusCode).toBe(409);

    releaseClose();
    const retried = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(store.getProject(project.id)).toBeUndefined();
    expect(driver.close).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("tears down the browser before deleting its owning agent", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    const { project, agent } = await startBrowserRun(app);

    const deletion = await deleteAgentsWithServerPreview(app, project.id, [agent.id]);
    expect(deletion.statusCode, deletion.body).toBe(200);
    await expect.poll(() => vi.mocked(driver.close).mock.calls.length).toBe(1);
    await app.close();
  });

  it("tears down the browser during daemon shutdown", async () => {
    adapter.mode = "hang";
    const driver = trackedBrowserDriver();
    const app = createServer({ dataDir, store, engines, logger: false, browserDriverFactory: async () => driver });
    await startBrowserRun(app);

    await app.close();
    expect(driver.close).toHaveBeenCalledTimes(1);
  });
});

describe("token usage API", () => {
  it("applies long-context pricing to individual provider requests", () => {
    const profile: ApiPriceProfile = {
      id: "tiered", pricingModel: "tiered", catalogVersion: "test", effectiveAt: "2026-01-01",
      sourceUrl: "https://example.test/pricing", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 5,
      longContext: { inputTokenThreshold: 100, inputMultiplier: 2, outputMultiplier: 1.5 },
    };
    const aggregate = { inputTokens: 160, cachedInputTokens: 20, outputTokens: 30, totalTokens: 190 };

    expect(projectedRunCost(aggregate, profile, [
      { inputTokens: 80, cachedInputTokens: 10, outputTokens: 15, totalTokens: 95 },
      { inputTokens: 80, cachedInputTokens: 10, outputTokens: 15, totalTokens: 95 },
    ])?.usd).toBeCloseTo(0.000292);
    expect(projectedRunCost(aggregate, profile, [
      { inputTokens: 120, cachedInputTokens: 20, outputTokens: 20, totalTokens: 140 },
      { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10, totalTokens: 50 },
    ])?.usd).toBeCloseTo(0.000444);
    expect(projectedRunCost(aggregate, profile)).toBeUndefined();
  });

  it("reports provider usage at agent, project, and overall scopes after a real run", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    adapter.turnUsage = { inputTokens: 120, cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 150 };
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Meter this run" } })).statusCode).toBe(202);
    await waitForRun(agent.id);
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("completed");

    const agentUsage = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}/usage` })).json();
    expect(agentUsage).toMatchObject({ scope: "agent", scopeId: agent.id, inputTokens: 120, cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 30, totalTokens: 150, finalizedRuns: 1, reportedRuns: 1, coverage: 1 });
    expect(agentUsage.metricAvailability).toMatchObject({ inputTokens: "available", cachedInputTokens: "available", reasoningOutputTokens: "available" });
    expect(agentUsage.breakdown).toEqual([expect.objectContaining({ projectId: project.id, agentId: agent.id, runs: 1, usage: expect.objectContaining({ totalTokens: 150 }), pricingAvailableRuns: 1 })]);
    expect(agentUsage.recentTurns[0]).toMatchObject({ projectId: project.id, agentId: agent.id, executionId: expect.any(String), pricingAvailable: true });
    expect(agentUsage.projectedApiCost).toMatchObject({
      usd: 0.000239, basis: "api_list_price_proxy", pricedRuns: 1, unpricedRuns: 0, coverage: 1,
      components: {
        uncachedInput: { tokens: 60, usd: 0.00006 },
        cachedInput: { tokens: 40, usd: 0.000004 },
        cacheWriteInput: { tokens: 20, usd: 0.000025 },
        output: { tokens: 30, usd: 0.00015 },
      },
      breakdown: [{
        pricingModel: "mock-model",
        components: {
          uncachedInput: { tokens: 60, usd: 0.00006 },
          cachedInput: { tokens: 40, usd: 0.000004 },
          cacheWriteInput: { tokens: 20, usd: 0.000025 },
          output: { tokens: 30, usd: 0.00015 },
        },
      }],
    });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/usage` })).json()).toMatchObject({ scope: "project", totalTokens: 150 });
    expect((await app.inject({ method: "GET", url: "/api/usage" })).json()).toMatchObject({ scope: "overall", totalTokens: 150 });
    expect((await app.inject({ method: "GET", url: "/api/usage?from=2099-01-01T00:00:00.000Z" })).json()).toMatchObject({ scope: "overall", finalizedRuns: 0, recentTurns: [], breakdown: [] });
    expect((await app.inject({ method: "GET", url: "/api/usage?from=not-a-date" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/agents/missing/usage" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("idempotent runtime controls", () => {
  it("replays a stop receipt without appending a second cancellation", async () => {
    adapter.mode = "hang";
    const { app, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "stay active" } });
    await waitForSeedCount(1);
    const payload = activeRunCancellationPayload(store, agent.id, "stop-retry");
    const stale = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: { targetRunId: "previous-run", idempotencyKey: "stale-stop" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ cancelled: false, replayed: false, currentRunId: payload.targetRunId });
    expect(new CoordinationV3Store(store.sqlite).agentSnapshot(agent.id).activeRun?.id).toBe(payload.targetRunId);
    const first = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel`, payload });
    const second = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel`, payload });
    expect(first.json()).toEqual({ cancelled: true, replayed: false });
    expect(second.json()).toEqual({ cancelled: true, replayed: true });
    await app.close();
  });
});

describe("project lifecycle API", () => {
  it("deduplicates retried Project chat sends by their stable idempotency key", async () => {
    const { app, project } = await createProjectAndAgent();
    const conversationId = project.lastConversationId!;
    const request = { text: "#broadcast Retry-safe update", idempotencyKey: "broadcast-retry" };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: request });
    const second = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: request });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(store.getConversationMessages(conversationId).filter((message) => message.text.includes("Retry-safe update"))).toHaveLength(1);
    expect(store.readCommunicationEvents(project.id).filter((event) => event.idempotencyKey === `broadcast:${conversationId}:broadcast-retry`)).toHaveLength(1);
    await app.close();
  });

  it("accepts text, attachments, and attachment-only Broadcast and Collaboration sends", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const conversationId = store.getProject(project.id)!.lastConversationId!;
    const agentTitle = store.getAgent(agent.id)!.title;
    expect((await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/conversation-memberships`,
      payload: { conversationIds: [conversationId], primaryConversationId: conversationId },
    })).statusCode).toBe(200);
    const upload = async (name: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/attachments`,
        headers: { "content-type": "application/pdf", "x-ponderosa-filename": name },
        payload: Buffer.from(`%PDF-1.7\n${name}`),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<Record<string, unknown>>();
    };

    const broadcastAsset = await upload("broadcast.pdf");
    const broadcast = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      payload: { text: "", attachments: [broadcastAsset], idempotencyKey: "attachment-only-broadcast" },
    });
    expect(broadcast.statusCode, broadcast.body).toBe(200);
    expect(broadcast.json()).toMatchObject({ text: "#broadcast", attachments: [{ id: broadcastAsset.id, name: "broadcast.pdf" }] });

    const collaborationAsset = await upload("collaboration.pdf");
    const collaboration = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/collaboration/messages`,
      payload: {
        text: "",
        recipientAgentIds: [agent.id],
        recipientAttachments: [{ agentId: agent.id, attachmentIds: [collaborationAsset.id] }],
        idempotencyKey: "attachment-only-collaboration",
      },
    });
    expect(collaboration.statusCode, collaboration.body).toBe(200);
    expect(collaboration.json()).toMatchObject({
      message: { text: `#${agentTitle}`, attachments: [{ id: collaborationAsset.id, name: "collaboration.pdf" }] },
      notifiedAgentIds: [agent.id],
    });
    const canonical = store.getCommunicationEvent(
      project.id,
      collaboration.json<{ message: { communicationEventId: string } }>().message.communicationEventId,
    );
    expect(canonical).toMatchObject({ text: "", attachments: [{ id: collaborationAsset.id }] });
    expect(new WorkspaceStore(dataDir).readSince(0).filter((item) =>
      item.event.type === "conversation_changed" && item.event.conversationId === conversationId && item.event.action === "message",
    )).toHaveLength(2);
    await app.close();
  });

  it("edits a Broadcast append-only without redelivery and survives reconnect/restart", async () => {
    let app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5, maxConcurrentRuns: 0 } });
    const project = store.createProject({ label: "Broadcast edits", hostPath: repoDir, defaultEngine: "codex" });
    const conversationId = project.lastConversationId!;
    const sent = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { text: "#broadcast Original shared note", idempotencyKey: "original-broadcast" },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const original = sent.json<{ id: string; communicationEventId: string }>();
    const runtimeBefore = new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id).length;
    const editPayload = { text: "#broadcast Edited shared note", idempotencyKey: "edit-broadcast", activeRunDelivery: "queue" };
    const edited = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages/${original.id}/corrections`, payload: editPayload });
    const replay = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages/${original.id}/corrections`, payload: editPayload });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ originalMessageId: original.id, queued: false, replayed: false });
    expect(replay.json()).toMatchObject({ originalMessageId: original.id, queued: false, replayed: true, correctionMessageId: edited.json<{ correctionMessageId: string }>().correctionMessageId });
    expect(store.readCommunicationEvents(project.id)).toHaveLength(1);
    expect(store.readCommunicationEvents(project.id)[0]).toMatchObject({ eventId: original.communicationEventId, text: "Original shared note" });
    expect(store.readCommunicationRevisions(project.id)).toHaveLength(1);
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id)).toHaveLength(runtimeBefore);
    expect(store.getConversationMessages(conversationId)).toEqual([
      expect.objectContaining({ id: original.id, communicationEventId: original.communicationEventId, text: "#broadcast Edited shared note", editRevision: 1 }),
    ]);

    await app.close();
    store = new AgentStore(dataDir);
    app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5, maxConcurrentRuns: 0 } });
    const reconnected = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    expect(reconnected.json<{ messages: Array<{ id: string; text: string; editRevision?: number }> }>().messages).toEqual([
      expect.objectContaining({ id: original.id, text: "#broadcast Edited shared note", editRevision: 1 }),
    ]);
    const changes = new WorkspaceStore(dataDir).readSince(0).filter((item) =>
      item.event.type === "conversation_changed" && item.event.conversationId === conversationId && item.event.action === "updated",
    );
    expect(changes).toHaveLength(1);
    await app.close();
  });

  it("does not redeliver a Broadcast edit to the runtime that already received the original", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const conversationId = store.getProject(project.id)!.lastConversationId!;
    await app.inject({
      method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`,
      payload: { conversationIds: [conversationId], primaryConversationId: conversationId },
    });
    adapter.mode = "hang";
    const original = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Original active request", sourceChannel: "main", sourceConversationId: conversationId, shareWithOrganization: true },
    });
    expect(original.statusCode, original.body).toBe(202);
    await waitForSeedCount(1);
    const originalMessage = store.getConversationMessages(conversationId).find((message) =>
      message.communicationEventId === original.json<{ communicationEventId: string }>().communicationEventId,
    )!;
    const runtimeBefore = new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id).length;
    const edited = await app.inject({
      method: "POST", url: `/api/conversations/${conversationId}/messages/${originalMessage.id}/corrections`,
      payload: { text: "Edited active request", idempotencyKey: "active-broadcast-edit", activeRunDelivery: "queue" },
    });
    expect(edited.json()).toMatchObject({ queued: false, replayed: false });
    await sleep(40);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.continues).toHaveLength(0);
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id)).toHaveLength(runtimeBefore);
    expect(store.getConversationMessages(conversationId).find((message) => message.id === originalMessage.id)).toMatchObject({
      text: "Edited active request", editRevision: 1,
    });
    await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: activeRunCancellationPayload(store, agent.id, "stop-active-edit-test"),
    });
    await app.close();
  });

  it("persists staged draft attachments and restores them after a server restart", async () => {
    let app = createServer({ dataDir, store, engines, logger: false });
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Drafts", hostPath: repoDir, defaultEngine: "codex" } });
    const project = created.json<{ id: string }>();
    const conversationId = store.getProject(project.id)!.lastConversationId!;
    const upload = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/draft-attachments`,
      headers: { "content-type": "application/octet-stream", "x-ponderosa-media-type": "text/plain", "x-ponderosa-filename": "notes.txt" },
      payload: Buffer.from("durable draft file"),
    });
    expect(upload.statusCode).toBe(201);
    const attachment = upload.json<{ id: string; downloadUrl: string }>();
    const saved = await app.inject({ method: "PUT", url: `/api/conversations/${conversationId}/draft`, payload: { text: "keep this", attachmentIds: [attachment.id], expectedRevision: 0, clientId: "tab-a" } });
    expect(saved.json()).toMatchObject({ text: "keep this", attachmentIds: [attachment.id], attachments: [{ id: attachment.id, name: "notes.txt" }] });
    expect((await app.inject({ method: "GET", url: attachment.downloadUrl })).rawPayload.toString()).toBe("durable draft file");

    await app.close();
    store = new AgentStore(dataDir);
    app = createServer({ dataDir, store, engines, logger: false });
    const restored = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/draft` });
    expect(restored.json()).toMatchObject({ revision: 1, text: "keep this", attachments: [{ id: attachment.id }] });
    const conflict = await app.inject({ method: "PUT", url: `/api/conversations/${conversationId}/draft`, payload: { text: "stale", attachmentIds: [], expectedRevision: 0, clientId: "tab-b" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ current: { revision: 1, text: "keep this" }, displaced: { text: "stale", clientId: "tab-b" } });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/draft-conflicts` })).json()).toMatchObject({ conversationId, conflicts: [expect.objectContaining({ displaced: expect.objectContaining({ text: "stale" }) })] });
    await app.close();
  });

  it("persists independent drafts for Project, Collaboration, and Agent chats", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const conversationId = store.getProject(project.id)!.lastConversationId!;
    const surfaces = [conversationId, `collaboration:${conversationId}`, `agent:${agent.id}`];
    for (const [index, surface] of surfaces.entries()) {
      const saved = await app.inject({
        method: "PUT",
        url: `/api/conversations/${encodeURIComponent(surface)}/draft`,
        payload: { text: `draft-${index}`, attachmentIds: [], expectedRevision: 0, clientId: "tab-a" },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ conversationId: surface, text: `draft-${index}`, revision: 1 });
    }
    expect((await app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(`agent:${agent.id}`)}/draft` })).json()).toMatchObject({ text: "draft-2" });
    await app.close();
  });

  it("projects normalized agent citations into the message Sources contract", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Sources", hostPath: repoDir, defaultEngine: "codex" });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, { title: "Researcher", engine: "codex", conversationId });
    const eventId = randomUUID();
    const citations = normalizeExternalCitations([{ url: "https://example.com/reference", title: "Reference" }], "2026-01-01T00:00:00.000Z");
    store.appendCommunicationEvent({
      eventId, schemaVersion: 2, projectId: project.id, conversationId,
      sender: { kind: "agent", agentId: agent.id, executionId: "run" },
      intent: "broadcast", audience: { kind: "organization", organizationId: project.id },
      text: "Verified finding", citations, createdAt: new Date().toISOString(),
    });
    store.appendConversationMessage(conversationId, { role: "assistant", text: "Verified finding" }, agent.id, "main", undefined, undefined, eventId);
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    expect(detail.json<{ messages: Array<{ citations?: unknown }> }>().messages[0]?.citations).toEqual(citations);
    await app.close();
  });

  it("bridges runtime lifecycle, task, file, and completion events into the workspace cursor", async () => {
    const { app, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Run with workspace updates" } });
    await waitForRun(agent.id);
    const allEvents = new WorkspaceStore(dataDir).readSince(0).map((item) => item.event);
    const events = allEvents.filter((event) => event.type === "agent_event");
    expect(events.map((event) => event.type === "agent_event" ? event.category : undefined)).toEqual(expect.arrayContaining(["lifecycle", "task", "file"]));
    expect(events.some((event) => event.type === "agent_event" && ["text", "reasoning", "agent_output", "turn_done"].includes(event.eventType))).toBe(false);
    expect(allEvents.some((event) => event.type === "usage_changed" && event.agentId === agent.id)).toBe(true);
    expect(events.every((event) => event.type !== "agent_event" || event.agentId === agent.id)).toBe(true);
    await app.close();
  });

  it("generates a concise New chat title locally without spending an agent run", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Titles", hostPath: repoDir, defaultEngine: "codex" });
    const conversationId = project.lastConversationId!;
    appendCanonicalMessage(store, project.id, conversationId, { text: "Track down the flaky cache invalidation" });
    appendCanonicalMessage(store, project.id, conversationId, { text: "I found the stale cursor path" }, "agent-title");
    const generated = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/generate-title` });
    expect(generated.json()).toEqual({ title: "Found Stale Cursor Path", generated: true });
    expect(store.getConversation(conversationId)?.title).toBe("Found Stale Cursor Path");
    expect(adapter.seeds).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/generate-title` })).json()).toEqual({ title: "Found Stale Cursor Path", generated: false });
    await app.close();
  });

  it("creates a private managed workspace when a working folder is omitted", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const response = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Missing folder", defaultEngine: "codex" } });
    expect(response.statusCode).toBe(200);
    const project = response.json<{ hostPath: string }>();
    expect(project.hostPath.startsWith(path.join(dataDir, "workspaces", "project-"))).toBe(true);
    expect(readdirSync(project.hostPath)).toEqual([]);
    await app.close();
  });

  it("lists only registered and managed folders and creates a named empty managed folder", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    store.createProject({ label: "Registered", hostPath: repoDir });
    const outside = mkdtempSync(path.join(tmpdir(), "pond-unregistered-"));
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Created", createFolderName: "fresh-work", defaultEngine: "codex" } });
    expect(created.statusCode).toBe(200);
    const createdProject = created.json<{ hostPath: string }>();
    expect(createdProject.hostPath).toBe(path.join(dataDir, "workspaces", "fresh-work"));
    expect(readdirSync(createdProject.hostPath)).toEqual([]);
    const choices = await app.inject({ method: "GET", url: "/api/project-folders" });
    const paths = choices.json<{ folders: Array<{ hostPath: string }> }>().folders.map((folder) => folder.hostPath);
    expect(paths).toContain(repoDir);
    expect(paths).toContain(createdProject.hostPath);
    expect(paths).not.toContain(outside);
    const collision = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Collision", createFolderName: "fresh-work", defaultEngine: "codex" } });
    expect(collision.statusCode).toBe(409);
    rmSync(outside, { recursive: true, force: true });
    await app.close();
  });

  it("browses only configured host roots and rejects symlink traversal", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    mkdirSync(path.join(repoDir, "inside"));
    const outside = mkdtempSync(path.join(tmpdir(), "pond-browse-outside-"));
    symlinkSync(outside, path.join(repoDir, "escape"));
    const listed = await app.inject({ method: "GET", url: `/api/project-folders/browse?path=${encodeURIComponent(repoDir)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ folders: Array<{ name: string }> }>().folders.map((item) => item.name)).toEqual(["inside"]);
    expect((await app.inject({ method: "GET", url: `/api/project-folders/browse?path=${encodeURIComponent(path.join(repoDir, "escape"))}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Escape", hostPath: outside, defaultEngine: "codex" } })).statusCode).toBe(400);
    rmSync(outside, { recursive: true, force: true });
    await app.close();
  });

  it("renames and permanently deletes canonical project data without deleting source files", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Before", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: master.id });
    store.appendEvent(agent.id, { type: "user_message", text: "canonical execution input" });
    const renamed = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { label: "After" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: project.id, label: "After", hostPath: repoDir });
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(store.getProject(project.id)).toBeUndefined();
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(existsSync(path.join(dataDir, "projects", project.id))).toBe(false);
    expect(existsSync(path.join(repoDir, "README.md"))).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/files?projectId=${project.id}` })).statusCode).toBe(404);
    await app.close();
  });
});

describe("persistent engine steering", () => {
  it("fences stale message publication after an acknowledged steer", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeSteers = false;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Steering fence", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "original" } });
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "new direction" } });
    await vi.waitFor(() => expect(persistent.steers).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;
    const stale = await runtime.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: { intent: "direct_to_user", text: "stale answer", idempotencyKey: "stale-answer" },
    });
    expect(stale.success).toBe(false);
    const rejection = JSON.parse(stale.text) as { requiredSteeringInjectionId: string };
    expect(rejection.requiredSteeringInjectionId).toBeTruthy();
    const current = await runtime.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: {
        intent: "direct_to_user", text: "current answer", idempotencyKey: "current-answer",
        steeringInjectionId: rejection.requiredSteeringInjectionId,
      },
    });
    expect(current.success, current.text).toBe(true);
    persistent.completeTurn(0);
    await app.close();
  });

  it("surfaces uncertain delivery and lets the operator recover after the current Run", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { steeringRecoveryGraceMs: 60_000 },
    });
    const project = store.createProject({ label: "Steering receipt", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "keep working" } });
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));
    persistent.failNextSteer = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "change direction" } });

    let uncertain!: import("@ponderosa/core").MessageDeliveryReceiptDto;
    await vi.waitFor(async () => {
      const detail = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}` }))
        .json<import("@ponderosa/core").AgentDetailDto>();
      const message = detail.messages.find((candidate) => candidate.text === "change direction");
      uncertain = message?.deliveryReceipts?.[0]!;
      expect(uncertain).toMatchObject({ state: "unconfirmed", canLetCurrentRunFinish: true });
    });
    const wait = await app.inject({
      method: "POST",
      url: `/api/message-deliveries/${uncertain.injectionId}/let-current-run-finish`,
      payload: { idempotencyKey: "let-current-finish" },
    });
    expect(wait.statusCode).toBe(202);
    expect(wait.json()).toMatchObject({ accepted: true, state: "waiting_for_run" });
    expect(persistent.interrupted).toBe(0);
    expect(persistent.starts).toHaveLength(1);
    const detail = (await app.inject({ method: "GET", url: `/api/conversations/${master.id}` }))
      .json<import("@ponderosa/core").ConversationDetailDto>();
    expect(detail.messages.find((message) => message.text.includes("change direction"))?.deliveryReceipts)
      .toEqual([expect.objectContaining({ state: "waiting_for_run" })]);
    await app.close();
  });

  it("retries a terminal uncertain operator delivery once through the public API", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { steeringRecoveryGraceMs: 60_000 },
    });
    const project = store.createProject({ label: "Delivery retry", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "keep working" } });
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));
    persistent.failNextSteer = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "change direction" } });

    let uncertain!: import("@ponderosa/core").MessageDeliveryReceiptDto;
    await vi.waitFor(async () => {
      const detail = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}` }))
        .json<import("@ponderosa/core").AgentDetailDto>();
      uncertain = detail.messages.find((candidate) => candidate.text === "change direction")?.deliveryReceipts?.[0]!;
      expect(uncertain).toMatchObject({ state: "unconfirmed", attemptCount: 1 });
    });
    store.sqlite.prepare("DELETE FROM scheduler_steering_recoveries WHERE injection_id = ?")
      .run(uncertain.injectionId);

    const first = await app.inject({
      method: "POST",
      url: `/api/message-deliveries/${uncertain.activationId}/retry`,
      payload: { idempotencyKey: `operator-delivery-retry:${uncertain.activationId}` },
    });
    expect(first.statusCode).toBe(202);
    const accepted = first.json<import("@ponderosa/core").RetryMessageDeliveryResponse>();
    expect(accepted).toMatchObject({
      accepted: true, replayed: false, state: "queued", retryMayDuplicate: true,
      targetAgentId: agent.id, activationId: expect.any(String),
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/message-deliveries/${uncertain.activationId}/retry`,
      payload: { idempotencyKey: `operator-delivery-retry:${uncertain.activationId}` },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ ...accepted, replayed: true });
    const competing = await app.inject({
      method: "POST",
      url: `/api/message-deliveries/${uncertain.activationId}/retry`,
      payload: { idempotencyKey: "competing-delivery-retry" },
    });
    expect(competing.statusCode).toBe(409);
    expect(competing.json()).toMatchObject({ accepted: false, rejectionReason: "stale_attempt" });
    await app.close();
  });

  it("automatically interrupts the exact uncertain Run and starts an audit-first recovery", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { steeringRecoveryGraceMs: 0, pollMs: 10 },
    });
    const project = store.createProject({ label: "Automatic steering recovery", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "keep working" } });
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));
    persistent.failNextSteer = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "change direction" } });

    await vi.waitFor(() => expect(persistent.starts).toHaveLength(2));
    expect(persistent.interrupted).toBe(1);
    expect(persistent.starts[1]?.prompt).toContain("Audit current project and runtime state before acting");
    expect(persistent.starts[1]?.prompt).toContain("Original user message:\nchange direction");
    await vi.waitFor(() => expect(store.sqlite.prepare(`
      SELECT state FROM agent_activations WHERE kind = 'steering_recovery'
    `).get()).toEqual({ state: "attached" }));
    const detail = (await app.inject({ method: "GET", url: `/api/conversations/${master.id}` }))
      .json<import("@ponderosa/core").ConversationDetailDto>();
    expect(detail.messages.find((message) => message.text.includes("change direction"))?.deliveryReceipts)
      .toEqual([expect.objectContaining({ state: "recovering" })]);
    await app.close();
  });

  it("reuses session-scoped capabilities while authorizing only the current turn", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1 },
    });
    const project = store.createProject({ label: "Persistent capabilities", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Dinosaur", engine: "codex", conversationId: master.id });
    const statuses: number[] = [];
    const observedTokens: string[] = [];
    persistent.onStartedTurn = async (turnNumber, environment) => {
      observedTokens.push(environment.PONDEROSA_AGENT_MESSAGE_TOKEN!);
      const sent = await app.inject({
        method: "POST", url: "/api/agent-messages",
        headers: { authorization: `Bearer ${environment.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "direct_to_user", text: `reply ${turnNumber}` },
      });
      statuses.push(sent.statusCode);
    };

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first" } });
    await waitForRun(agent.id);
    const expiredBetweenTurns = await app.inject({
      method: "POST", url: "/api/agent-messages",
      headers: { authorization: `Bearer ${observedTokens[0]}` },
      payload: { intent: "direct_to_user", text: "must fail while idle" },
    });
    expect(expiredBetweenTurns.statusCode).toBe(401);

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "second" } });
    await waitForRun(agent.id, 2);
    expect(persistent.opened).toBe(1);
    expect(observedTokens).toEqual([observedTokens[0], observedTokens[0]]);
    expect(statuses).toEqual([200, 200]);
    expect(store.getConversationMessages(master.id).filter((message) => message.authorAgentId === agent.id)
      .map((message) => message.text)).toEqual(["#user reply 1", "#user reply 2"]);
    await app.close();
  });

  it("closes an idle persistent runtime after the bounded warm-session TTL", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let idleCallback: (() => void) | undefined;
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        idleTtlMs: 10,
        maxIdleSessions: 1,
        setTimer: (callback) => {
          idleCallback = callback;
          return { unref() {} } as unknown as NodeJS.Timeout;
        },
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Runtime TTL", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Bounded", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } });
    await waitForRun(agent.id);
    expect(persistent.opened).toBe(1);
    expect(persistent.closed).toBe(0);
    idleCallback?.();
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await app.close();
    expect(persistent.closed).toBe(1);
  });

  it("retains a failed idle teardown and fences replacement until retry confirms exit", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    persistent.closeFailuresRemaining = 1;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let idleCallback: (() => void) | undefined;
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        idleTtlMs: 10,
        maxIdleSessions: 1,
        setTimer: (callback) => {
          idleCallback = callback;
          return { unref() {} } as unknown as NodeJS.Timeout;
        },
        clearTimer: () => undefined,
      },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Retryable runtime teardown", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Retained", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first" } });
    await waitForRun(agent.id);
    idleCallback?.();
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ dedupeKey: `runtime-teardown:${agent.id}`, status: "open" }),
      ]));

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "retry safely" } });
    await waitForRun(agent.id, 2);
    expect(persistent.closed).toBe(2);
    expect(persistent.opened).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ dedupeKey: `runtime-teardown:${agent.id}`, status: "resolved" }),
      ]));
    await app.close();
  });

  it("does not open a replacement while an earlier runtime termination is in flight", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    let releaseClose!: () => void;
    persistent.closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let idleCallback: (() => void) | undefined;
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        idleTtlMs: 10,
        maxIdleSessions: 1,
        setTimer: (callback) => {
          idleCallback = callback;
          return { unref() {} } as unknown as NodeJS.Timeout;
        },
        clearTimer: () => undefined,
      },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "In-flight runtime teardown", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Serialized", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first" } });
    await waitForRun(agent.id);
    idleCallback?.();
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "must wait" } });
    await sleep(40);
    expect(persistent.opened).toBe(1);
    releaseClose();
    await waitForRun(agent.id, 2);
    expect(persistent.opened).toBe(2);
    await app.close();
  });

  it("closes idle persistent runtimes by default instead of retaining an implicit warm pool", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "No implicit warm pool", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Ephemeral", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } });
    await waitForRun(agent.id);

    expect(persistent.opened).toBe(1);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await app.close();
  });

  it("bounds the global warm-idle runtime pool and resumes an evicted agent normally", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let now = 0;
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        idleTtlMs: 60_000,
        maxIdleSessions: 2,
        now: () => ++now,
        setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Warm pool", hostPath: repoDir });
    const agents = ["Oldest", "Middle", "Newest"].map((title) =>
      store.createAgent(project.id, { title, engine: "codex" }));

    for (const agent of agents) {
      await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: `run ${agent.title}` } });
      await waitForRun(agent.id);
    }

    expect(persistent.opened).toBe(3);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));

    await app.inject({ method: "POST", url: `/api/agents/${agents[0]!.id}/messages`, payload: { text: "resume oldest" } });
    await waitForRun(agents[0]!.id, 2);
    expect(persistent.opened).toBe(4);
    expect(persistent.openedOptions.at(-1)?.resumeSessionId).toBe("persistent-session");
    await app.close();
  });

  it("never evicts an active runtime to satisfy the warm-idle limit", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        maxIdleSessions: 1,
        setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Active runtime", hostPath: repoDir });
    const active = store.createAgent(project.id, { title: "Active", engine: "codex" });
    const firstIdle = store.createAgent(project.id, { title: "First idle", engine: "codex" });
    const secondIdle = store.createAgent(project.id, { title: "Second idle", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${active.id}/messages`, payload: { text: "keep working" } });
    await vi.waitFor(() => expect(persistent.opened).toBe(1));
    persistent.completeStartedTurns = true;
    for (const agent of [firstIdle, secondIdle]) {
      await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "finish" } });
      await waitForRun(agent.id);
    }
    await vi.waitFor(() => expect(persistent.closed).toBe(1));

    const steered = await app.inject({ method: "POST", url: `/api/agents/${active.id}/messages`, payload: { text: "still alive" } });
    expect(steered.statusCode).toBe(202);
    expect(steered.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    await waitForRun(active.id);
    expect(persistent.opened).toBe(3);
    await app.close();
  });

  it("keeps server shutdown pending through provider SIGKILL and observed exit", async () => {
    const children: ChildProcess[] = [];
    const persistent = stubbornProcessAdapter(children);
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Observed shutdown", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Stubborn", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep running" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(store.resumeSessionId(agent.id)).toBe("claude-stream-v1"));
    const pid = children[0]!.pid!;
    const closing = app.close();
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    expect(processAlive(pid)).toBe(true);
    await closing;
    expect(processAlive(pid)).toBe(false);
  });

  it("synchronously revokes an active persistent Run when its provider root exits", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Persistent root exit", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Root exit", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep running" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));
    const token = persistent.openedOptions[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;

    persistent.crashRoot(0);
    const rejected = await app.inject({
      method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` },
    });
    expect(rejected.statusCode).toBe(401);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await vi.waitFor(() => expect(new CoordinationV3Store(store.sqlite).agentSnapshot(agent.id).activeRun).toBeUndefined());
    await app.close();
  });

  it("retains a root-exited Run as a Project-deletion barrier until its event loop settles", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.closeLeavesEventsOpen = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Root-exit completion barrier", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Root exit barrier", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep the event loop open" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));

    persistent.crashRoot(0);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    const deletion = app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    let settled = false;
    void deletion.then(() => { settled = true; });
    await sleep(25);
    expect(settled).toBe(false);
    expect(store.getProject(project.id)).toBeDefined();

    persistent.closeEventStream(0);
    const deleted = await deletion;
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(store.getProject(project.id)).toBeUndefined();
    await app.close();
  });

  it("detaches an idle crashed persistent runtime before replacement work", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Idle persistent root exit", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Idle crash", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "First turn" } });
    await waitForRun(agent.id);
    expect(persistent.opened).toBe(1);
    persistent.crashRoot(0);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Replacement turn" } });
    await waitForRun(agent.id, 2);
    expect(persistent.opened).toBe(2);
    await app.close();
  });

  it("refuses a dead reusable session even when its root-exit callback was missed", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Dead reusable session", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Liveness gate", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "First turn" } });
    await waitForRun(agent.id);
    persistent.markDead(0);

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Do not reuse dead state" } });
    await waitForRun(agent.id, 2);
    expect(persistent.closed).toBeGreaterThanOrEqual(1);
    expect(persistent.opened).toBe(2);
    await app.close();
  });

  it("binds a reused persistent root exit to the current turn instead of its opening Run", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Reused persistent root exit", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Second-turn crash", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Open the session" } });
    await waitForRun(agent.id);
    persistent.completeStartedTurns = false;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Reuse the session" } });
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(2));
    expect(persistent.opened).toBe(1);

    const token = persistent.openedOptions[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    persistent.crashRoot(0);
    expect((await app.inject({
      method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(401);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await vi.waitFor(() => expect(new CoordinationV3Store(store.sqlite).agentSnapshot(agent.id).activeRun).toBeUndefined());

    persistent.completeStartedTurns = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Start safely again" } });
    await waitForRun(agent.id, 2);
    expect(persistent.opened).toBe(2);
    expect(persistent.starts).toHaveLength(3);
    await app.close();
  });

  it("awaits non-persistent Run completion until a stubborn descendant exits", async () => {
    const children: ChildProcess[] = [];
    const pidFile = path.join(dataDir, "one-shot-descendant.json");
    engines = [{ adapter: stubbornOneShotAdapter(children, pidFile), authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Observed one-shot shutdown", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "One shot", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep running" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(() => readFileSync(pidFile, "utf8")).not.toThrow());
    const descendantPid = JSON.parse(readFileSync(pidFile, "utf8")) as { descendantPid: number };

    const closing = app.close();
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await sleep(25);
    expect(settled).toBe(false);
    expect(processAlive(descendantPid.descendantPid)).toBe(true);
    await closing;
    expect(processAlive(descendantPid.descendantPid)).toBe(false);
    expect(children[0]?.exitCode).not.toBeNull();
  });

  it("retains a failed one-shot termination handle and deletes the Project only after an exact retry succeeds", async () => {
    const fallback = new MockAdapter();
    let closeAttempts = 0;
    let spawned = false;
    let alive = true;
    let closePromise: Promise<void> | undefined;
    const handle = {
      isAlive: () => alive,
      close: () => {
        if (closePromise) return closePromise;
        closeAttempts += 1;
        const attempt = closeAttempts;
        const operation = Promise.resolve().then(() => {
          if (attempt === 1) throw new Error("simulated one-shot process-group termination failure");
          alive = false;
        });
        const shared = operation.catch((error) => {
          if (closePromise === shared) closePromise = undefined;
          throw error;
        });
        closePromise = shared;
        return shared;
      },
    };
    const execute = async function* (options: SeedOptions | ContinueOptions): AsyncIterable<AgentEvent> {
      options.onRuntimeSpawned?.(handle);
      spawned = true;
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    engines = [{
      adapter: {
        id: "codex", displayName: "Retrying one-shot runtime",
        listModels: () => fallback.listModels(), listEfforts: () => fallback.listEfforts(),
        apiPriceProfile: () => fallback.apiPriceProfile(), seed: execute, continue: execute,
      },
      authStatus: async () => ({ authenticated: true }),
    }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Retry one-shot deletion", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "One shot", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep running" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(spawned).toBe(true));

    const blocked = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(blocked.statusCode, blocked.body).toBe(503);
    expect(store.getProject(project.id)).toBeDefined();
    expect(alive).toBe(true);

    const retried = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(store.getProject(project.id)).toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(alive).toBe(false);
    await app.close();
  });

  it("blocks a queued successor until failed one-shot cleanup confirms process exit", async () => {
    const fallback = new MockAdapter();
    let executions = 0;
    let firstCloseAttempts = 0;
    let firstAlive = true;
    let releaseRetry!: () => void;
    const retryBarrier = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const firstHandle: RuntimeProcessHandle = {
      isAlive: () => firstAlive,
      close: async () => {
        firstCloseAttempts += 1;
        if (firstCloseAttempts === 1) throw new Error("simulated first one-shot close failure");
        await retryBarrier;
        firstAlive = false;
      },
    };
    const execute = async function* (options: SeedOptions | ContinueOptions): AsyncIterable<AgentEvent> {
      executions += 1;
      let alive = true;
      const handle: RuntimeProcessHandle = executions === 1 ? firstHandle : {
        isAlive: () => alive,
        close: async () => { alive = false; },
      };
      options.onRuntimeSpawned?.(handle);
      yield { type: "session", sessionId: `one-shot-${executions}` };
      yield { type: "turn_done" };
    };
    engines = [{
      adapter: {
        id: "codex", displayName: "Serialized one-shot runtime",
        listModels: () => fallback.listModels(), listEfforts: () => fallback.listEfforts(),
        apiPriceProfile: () => fallback.apiPriceProfile(), seed: execute, continue: execute,
      },
      authStatus: async () => ({ authenticated: true }),
    }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "One-shot successor gate", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Serialized one shot", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "First" } });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Second" } });
    await waitForRun(agent.id);
    await vi.waitFor(() => expect(firstCloseAttempts).toBeGreaterThanOrEqual(2));
    expect(executions).toBe(1);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs WHERE agent_id = ?")
      .get(agent.id)).toEqual({ count: 1 });

    releaseRetry();
    await waitForRun(agent.id, 2);
    expect(firstAlive).toBe(false);
    expect(executions).toBe(2);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs WHERE agent_id = ?")
      .get(agent.id)).toEqual({ count: 2 });
    await app.close();
  });

  it("drains a provider that finishes opening after Project deletion begins", async () => {
    const persistent = new SteerableMockAdapter();
    let releaseOpen!: () => void;
    persistent.openBarrier = new Promise<void>((resolve) => { releaseOpen = resolve; });
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Delete during open", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Opening", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Open slowly" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.opened).toBe(1));

    const deletion = app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    let settled = false;
    void deletion.then(() => { settled = true; });
    await sleep(25);
    expect(settled).toBe(false);
    expect(store.getProject(project.id)).toBeDefined();
    releaseOpen();

    const deleted = await deletion;
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(persistent.closed).toBe(1);
    expect(store.getProject(project.id)).toBeUndefined();
    await app.close();
  });

  it("drains a provider that finishes opening after server shutdown begins", async () => {
    const persistent = new SteerableMockAdapter();
    let releaseOpen!: () => void;
    persistent.openBarrier = new Promise<void>((resolve) => { releaseOpen = resolve; });
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 } });
    const project = store.createProject({ label: "Shutdown during open", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Opening", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Open slowly" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.opened).toBe(1));

    const closing = app.close();
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await sleep(25);
    expect(settled).toBe(false);
    releaseOpen();
    await closing;
    expect(persistent.closed).toBe(1);
  });

  it("retains a rejected opening handle for Project-deletion cleanup retry", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.openFailure = new Error("simulated thread/start rejection");
    persistent.closeFailuresRemaining = 1;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxDeliveryFailures: 1 },
    });
    const project = store.createProject({ label: "Rejected open deletion", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Opening", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Fail readiness" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    expect(persistent.openedOptions[0]?.onRuntimeSpawned).toEqual(expect.any(Function));

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(persistent.closed).toBe(2);
    expect(store.getProject(project.id)).toBeUndefined();
    await app.close();
  });

  it("retains a rejected opening handle for daemon-shutdown cleanup retry", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.openFailure = new Error("simulated initialize rejection");
    persistent.closeFailuresRemaining = 1;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxDeliveryFailures: 1 },
    });
    const project = store.createProject({ label: "Rejected open shutdown", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Opening", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Fail readiness" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));

    await app.close();
    expect(persistent.closed).toBe(2);
  });

  it("revokes provider authority even when an earlier shutdown cleanup fails", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      shutdownFaults: { backgroundCleanup: () => { throw new Error("injected watcher shutdown failure"); } },
    });
    const project = store.createProject({ label: "Independent provider cleanup", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Warm", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "finish" } });
    await waitForRun(agent.id);

    await expect(app.close()).rejects.toThrow(/Ponderosa server shutdown did not complete/);
    expect(persistent.closed).toBe(1);
  });

  it("attempts every runtime barrier before reporting aggregate shutdown failure", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 2, idleTtlMs: 60_000 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Exhaustive shutdown", hostPath: repoDir });
    const agents = ["First", "Second"].map((title) =>
      store.createAgent(project.id, { title, engine: "codex" }));
    for (const agent of agents) {
      await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "finish" } });
      await waitForRun(agent.id);
    }
    persistent.closeFailuresRemaining = 1;
    await expect(app.close()).rejects.toThrow(/Ponderosa server shutdown did not complete/);
    expect(persistent.closed).toBe(2);
    await app.retryProviderRuntimeShutdown();
    expect(persistent.closed).toBe(3);
  });
});

async function cancelAndWait(app: ReturnType<typeof createServer>, agentId: string): Promise<void> {
  const agent = store.getAgent(agentId);
  const targetRunId = new CoordinationV3Store(store.sqlite).agentSnapshot(agentId).activeRun?.id;
  if (!targetRunId) return;
  const payload = { targetRunId, idempotencyKey: `test-stop:${randomUUID()}` };
  const cancelled = await app.inject({ method: "POST", url: `/api/agents/${agentId}/cancel`, payload });
  expect([200, 409], cancelled.body).toContain(cancelled.statusCode);
  for (let i = 0; i < 80; i += 1) {
    if (!agent) return;
    const health = await app.inject({ method: "GET", url: `/api/projects/${agent.projectId}/agent-health` });
    const runtimeActivity = health.json<{ agents: Array<{ agentId: string; runtimeActivity?: { executionId: string } }> }>()
      .agents.find((item) => item.agentId === agentId)?.runtimeActivity;
    if (runtimeActivity?.executionId !== targetRunId) return;
    await sleep(10);
  }
  throw new Error("run did not cancel");
}

describe("server chunk F", () => {
  it("repairs unavailable pending recipients before the startup scheduler can claim them", async () => {
    const project = store.createProject({ label: "Startup repair", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Deleted", engine: "codex" });
    const coordination = new CoordinationV3Store(store.sqlite);
    const activationId = coordination.enqueueMessageActivation({
      projectId: project.id, agentId: agent.id, messageId: "startup-poison", kind: "human", payload: { text: "Wake" },
    });
    store.sqlite.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    expect(coordination.terminalActivations(project.id)).toContainEqual(expect.objectContaining({
      id: activationId,
      outcome: "recipient_unavailable",
      deliveryFailures: 0,
    }));
    expect(coordination.schedulerMetrics()).toMatchObject({ pendingActivations: 0, failedRuns: 0 });
    await app.close();
  });

  it("classifies a dispatch 404 as recipient_unavailable without another attempt", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5 },
    });
    await app.ready();
    const project = store.createProject({ label: "Dispatch recipient loss", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Deleted", engine: "codex" });
    const coordination = new CoordinationV3Store(store.sqlite);
    const activationId = coordination.enqueueMessageActivation({
      projectId: project.id, agentId: agent.id, messageId: "dispatch-poison", kind: "human", payload: { text: "Wake" },
    });
    store.sqlite.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);

    await vi.waitFor(() => expect(coordination.terminalActivations(project.id)).toContainEqual(
      expect.objectContaining({ id: activationId, outcome: "recipient_unavailable", deliveryFailures: 1 }),
    ));
    const failedRuns = coordination.schedulerMetrics().failedRuns;
    await sleep(25);
    expect(coordination.schedulerMetrics()).toMatchObject({
      pendingActivations: 0,
      failedRuns,
      recipientUnavailableActivations: 1,
    });
    await app.close();
  });

  it("exposes an idempotent targeted repair and its terminal delivery diagnostics", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 60_000 },
    });
    await app.ready();
    const project = store.createProject({ label: "Activation repair", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Deleted", engine: "codex" });
    const coordination = new CoordinationV3Store(store.sqlite);
    const activation = coordination.enqueueMessageActivation({
      projectId: project.id, agentId: agent.id, messageId: "poison", kind: "human", payload: { text: "Wake" },
    });
    store.sqlite.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);

    const payload = {
      projectId: project.id,
      idempotencyKey: "repair-poison-once",
      reason: "verified recipient deletion",
    };
    const repaired = await app.inject({
      method: "POST",
      url: `/api/communication-v3/activations/${activation}/settle-recipient-unavailable`,
      payload,
    });
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect(repaired.json()).toEqual({
      settled: true, replayed: false, status: "recipient_unavailable",
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/communication-v3/activations/${activation}/settle-recipient-unavailable`,
      payload,
    });
    expect(replay.json()).toEqual({
      settled: true, replayed: true, status: "recipient_unavailable",
    });
    const metrics = (await app.inject({ method: "GET", url: "/api/communication-v3/metrics" })).json<{
      storage: { recipientUnavailableActivations: number };
      recentTerminalActivations: Array<{ id: string; outcome: string }>;
    }>();
    expect(metrics.storage.recipientUnavailableActivations).toBe(1);
    expect(metrics.recentTerminalActivations).toContainEqual(
      expect.objectContaining({ id: activation, outcome: "recipient_unavailable" }),
    );
    await app.close();
  });

  it("detects a received-but-unpersisted event as stalled without cancelling the owned run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received = false;
    const transitions: string[] = [];
    const app = createServer({ dataDir, store, engines, logger: false, runtimeEventFaults: {
      stallAfterMs: 20,
      beforePersist: async ({ event }) => { if (event.type === "command") { received = true; await gate; } },
      onOwnershipState: ({ state }) => transitions.push(state),
    } });
    const project = store.createProject({ label: "Stall", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Stalled", engine: "codex" });
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(received).toBe(true));
    await sleep(25);
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    expect(health.json<{ agents: Array<{ status: string; reason: string; runtimeOwnership: string }> }>().agents[0])
      .toMatchObject({ status: "stalled", reason: "runtime_event_consumer_stalled", runtimeOwnership: "stalled" });
    expect(transitions.filter((state) => state === "stalled")).toHaveLength(1);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "command")).toBe(false);
    release();
    await waitForRun(agent.id);
    expect(transitions).toContain("running");
    await app.close();
  });

  it("fences a cancelled generation and executes its queued successor exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    const app = createServer({ dataDir, store, engines, logger: false, runtimeEventFaults: {
      beforePersist: async ({ event, generation }) => {
        if (generation === 1 && event.type === "command") { blocked = true; await gate; }
      },
    } });
    const project = store.createProject({ label: "Fence", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Fenced", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first prompt" } });
    await vi.waitFor(() => expect(blocked).toBe(true));
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "queued prompt" } })).statusCode).toBe(202);
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: activeRunCancellationPayload(store, agent.id, "fence-first-generation"),
    })).json()).toEqual({ cancelled: true, replayed: false });
    release();
    await vi.waitFor(() => expect(adapter.seeds.length + adapter.continues.length).toBe(2));
    await waitForRun(agent.id);
    expect(store.getMessages(agent.id).filter((message) => message.text === "queued prompt")).toHaveLength(1);
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.status === "completed")).toHaveLength(1);
    await app.close();
  });

  it("serves server-owned agent health at project and conversation scope", async () => {
    const project = store.createProject({ label: "Health", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: room.id });
    const outside = store.createAgent(project.id, { title: "Outside", engine: "codex" });
    const app = createServer({ dataDir, store, engines, logger: false });

    const roomHealth = await app.inject({ method: "GET", url: `/api/conversations/${room.id}/agent-health` });
    expect(roomHealth.statusCode).toBe(200);
    expect(roomHealth.json()).toMatchObject({
      scope: { type: "conversation", id: room.id },
      agents: [{ agentId: agent.id, status: "idle", reason: "no_active_work" }],
    });

    const projectHealth = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    expect(projectHealth.statusCode).toBe(200);
    expect(projectHealth.json<{ agents: Array<{ agentId: string }> }>().agents.map((item) => item.agentId).sort())
      .toEqual([agent.id, outside.id].sort());
    await app.close();
  });

  it("reports observed compaction and preserves ordinary cancellation", async () => {
    const project = store.createProject({ label: "Health transitions", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    const app = createServer({ dataDir, store, engines, logger: false });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Work" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect((await app.inject({
      method: "POST", url: "/api/agent-session/rollover",
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` })).json())
      .toMatchObject({ agents: [expect.objectContaining({ agentId: agent.id, status: "compacting", reason: "session_rollover_scheduled" })] });

    await cancelAndWait(app, agent.id);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` })).json())
      .toMatchObject({ agents: [expect.objectContaining({ agentId: agent.id, status: "cancelled", reason: "agent_cancelled" })] });
    await app.close();
  });

  it("bounds fresh-session history by both characters and message count", () => {
    const history = Array.from({ length: 80 }, (_, index) => ({ role: "user" as const, text: `${index}:` + "x".repeat(1_000) }));
    const bounded = boundedSeedHistory(history, 5_000, 4);
    expect(bounded).toHaveLength(4);
    expect(bounded.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(5_000);
    expect(bounded.at(-1)?.text.startsWith("79:")).toBe(true);
  });

  it("binds every runtime turn to one stable agent and execution identity", () => {
    const prompt = runtimeIdentityPrompt({ id: "agent-10", title: "Great Basin", projectId: "project-a" }, "execution-2");
    expect(prompt).toContain("your agent id: agent-10");
    expect(prompt).toContain("your display name: Great Basin");
    expect(prompt).toContain("You are exactly Great Basin (agent-10)");
    expect(prompt).toContain("your execution id: execution-2");
  });

  it("exposes and injects a structured Team Directory through run-bound discovery capabilities", async () => {
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Directory", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Directory room" });
    const preset = store.listAgentPresets(project.id).find((item) => item.name === "Frontend")!;
    const parent = store.createAgent(project.id, { title: "Lead", engine: "codex", presetId: preset.id, conversationId: room.id });
    const child = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: room.id }, {
      agentId: parent.id, executionId: "directory-run",
      prompt: "Challenge release safety and report concise findings.", idempotencyKey: "directory-reviewer",
    });
    store.updateAgentOrganization(child.id, { managerAgentId: parent.id });
    store.appendEvent(parent.id, { type: "work_item_update", workItemId: "directory", title: "Build directory", status: "running" });

    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Start" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const directory = await app.inject({ method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toMatchObject({ projectId: project.id, agents: expect.arrayContaining([
      expect.objectContaining({ agentId: parent.id, role: "Frontend", status: "running", childAgentIds: [child.id], engine: "codex" }),
      expect.objectContaining({
        agentId: child.id, managerAgentId: parent.id, role: "Reviewer",
        description: "Challenge release safety and report concise findings.",
      }),
    ]) });
    expect((await app.inject({ method: "GET", url: `/api/agent-directory/${child.id}`, headers: { authorization: `Bearer ${token}` } })).json())
      .toMatchObject({ agentId: child.id, managerAgentId: parent.id });
    expect(adapter.seeds[0]!.environment!.PONDEROSA_AGENT_DIRECTORY_URL).toContain("/api/agent-directory");
    expect(adapter.seeds[0]!.environment!.PONDEROSA_AGENT_CONTEXT_URL).toContain("/api/agent-context");
    expect(adapter.seeds[0]!.prompt).toContain("[TEAM DIRECTORY | ON-DEMAND REFERENCE]");
    expect(adapter.seeds[0]!.prompt).toContain("ponderosa_team_directory({})");
    expect(adapter.seeds[0]!.prompt).not.toContain("[OLDER SCOPED CONTEXT | ON-DEMAND REFERENCE]");
    expect(adapter.seeds[0]!.prompt).not.toContain("ponderosa_context({})");
    expect(adapter.seeds[0]!.prompt).not.toContain(`\"agentId\":\"${child.id}\"`);
    expect(adapter.seeds[0]!.prompt.match(/Common reply: ponderosa_message/g)).toHaveLength(1);
    const context = await app.inject({ method: "GET", url: "/api/agent-context?limit=10", headers: { authorization: `Bearer ${token}` } });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      scope: { kind: "project_chat", conversationId: room.id },
      messages: expect.arrayContaining([expect.objectContaining({ text: "Start", conversationId: room.id })]),
    });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/team-directory` })).statusCode).toBe(200);
    await cancelAndWait(app, parent.id);
    expect((await app.inject({ method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/agent-context", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    await app.close();
  });

  it("advertises older scoped context only when bounded provider input omitted it", async () => {
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Bounded context reference", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Historian", engine: "codex" });
    store.setImportedHistory(agent.id, "portable-agent-package", [{
      role: "system",
      text: "IMPORTED-EFFECTIVE-HISTORY",
      createdAt: "2026-07-16T23:59:59.000Z",
    }]);
    for (let index = 0; index < 41; index += 1) {
      const communicationEventId = randomUUID();
      store.appendCommunicationEvent({
        eventId: communicationEventId,
        schemaVersion: 2,
        projectId: project.id,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
        text: `historical-${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 17, 0, 0, index)).toISOString(),
      });
      store.appendEvent(agent.id, { type: "user_message", text: `historical-${index}`, communicationEventId });
    }

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Use history if needed" } });
    await waitForSeedCount(1);

    expect(adapter.seeds[0]!.prompt).toContain("[OLDER SCOPED CONTEXT | ON-DEMAND REFERENCE]");
    expect(adapter.seeds[0]!.prompt).toContain("ponderosa_context({})");
    const run = store.getRuns(agent.id).at(-1);
    const providerInput = run ? store.getProviderInput(run.id, true) : undefined;
    expect(providerInput?.sourceManifest.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context_reference", ref: agent.id, delivery: "submitted" }),
    ]));
    const token = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const retrieved = await app.inject({
      method: "GET",
      url: "/api/agent-context?limit=50",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json<{ messages: Array<{ text: string }> }>().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "[Imported private context]\nIMPORTED-EFFECTIVE-HISTORY" }),
    ]));

    await cancelAndWait(app, agent.id);
    await app.close();
  });

  it("keyset-pages every equal-time older-context message without tie loss", async () => {
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Tied context", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Historian", engine: "codex" });
    const tiedAt = "2026-07-16T23:59:59.000Z";
    store.setImportedHistory(agent.id, "tied-history", Array.from({ length: 51 }, (_, index) => ({
      role: "system" as const,
      text: `TIED-CONTEXT-${String(index).padStart(2, "0")}`,
      createdAt: tiedAt,
    })));

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Inspect older context" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    let cursor: string | undefined;
    const retrieved: string[] = [];
    do {
      const page = await app.inject({
        method: "GET",
        url: `/api/agent-context?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(page.statusCode, page.body).toBe(200);
      const body = page.json<{ messages: Array<{ text: string }>; hasMore: boolean; nextCursor?: string }>();
      retrieved.push(...body.messages.flatMap((message) => message.text.includes("TIED-CONTEXT-") ? [message.text] : []));
      cursor = body.nextCursor;
      expect(body.hasMore).toBe(Boolean(cursor));
    } while (cursor);

    expect(new Set(retrieved).size).toBe(51);
    expect(retrieved).toEqual(expect.arrayContaining([
      "[Imported private context]\nTIED-CONTEXT-00",
      "[Imported private context]\nTIED-CONTEXT-50",
    ]));
    await cancelAndWait(app, agent.id);
    await app.close();
  });

  it("excludes hidden, generated, and credential-like project references", () => {
    expect(isProjectFileReferenceAllowed("src/app.ts")).toBe(true);
    for (const candidate of [".git/config", ".env.example", ".oauth_tokens.json", "node_modules/pkg/index.js", "config/credentials.json", "build/app.js"]) {
      expect(isProjectFileReferenceAllowed(candidate), candidate).toBe(false);
    }
  });

  it("separates daemon liveness from work readiness", async () => {
    const app = createServer({
      dataDir,
      store,
      engines,
      authToken: "operator-secret",
      buildRevision: "test-revision-123",
      logger: false,
    });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      status: "ok",
      service: "ponderosa",
      version: "0.0.0",
      revision: "test-revision-123",
    });

    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      canAcceptWork: true,
      acceptingDurableIntake: true,
      leasingRuns: true,
      deploymentDrain: { state: "accepting", activeRuns: 0 },
      checks: {
        daemon: { ok: true },
        dataDirectory: { ok: true },
        projections: { ok: true },
        runtimes: { ok: true },
      },
      runtimes: [{ id: "codex", authenticated: true }],
    });
    const operator = { authorization: "Bearer operator-secret" };
    expect((await app.inject({ method: "POST", url: "/api/deployment/drain", headers: operator })).json()).toMatchObject({
      state: "draining", acceptingDurableIntake: true, leasingRuns: false, activeRuns: 0,
    });
    const drained = await app.inject({ method: "GET", url: "/api/ready" });
    expect(drained.statusCode).toBe(503);
    expect(drained.json()).toMatchObject({
      status: "not_ready", canAcceptWork: false, acceptingDurableIntake: true, leasingRuns: false,
      deploymentDrain: { state: "draining", activeRuns: 0 },
    });
    const project = store.createProject({ label: "Drain intake", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Queued", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, headers: operator, payload: { text: "Persist during drain" },
    })).statusCode).toBe(202);
    await sleep(20);
    expect(store.getRuns(agent.id)).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: "/api/deployment/resume", headers: operator })).json()).toMatchObject({
      state: "accepting", acceptingDurableIntake: true, leasingRuns: true,
    });
    await waitForRun(agent.id);
    await app.close();

    const unavailable = createServer({
      dataDir,
      store: new AgentStore(dataDir),
      engines: [{ adapter, authStatus: async () => ({ authenticated: false, detail: "login required" }) }],
      logger: false,
    });
    const notReady = await unavailable.inject({ method: "GET", url: "/api/ready" });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toMatchObject({
      status: "not_ready",
      canAcceptWork: false,
      acceptingDurableIntake: true,
      leasingRuns: true,
      checks: { daemon: { ok: true }, dataDirectory: { ok: true }, projections: { ok: true }, runtimes: { ok: false } },
      runtimes: [{ id: "codex", authenticated: false, detail: "login required" }],
    });
    await unavailable.close();
  });

  it("lets provider-confirmed entitlement failure override a stale login-positive probe", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Entitlement", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Claude-like", engine: "codex" });
    adapter.failureAfterBeforeResponse = "Your organization has disabled Claude subscription access";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Try provider" } });
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("failed");
    expect((await app.inject({ method: "GET", url: "/api/engines" })).json()).toContainEqual(expect.objectContaining({
      id: "codex", configured: true, authenticated: true, available: false,
      authDetail: "test", availabilityDetail: expect.stringContaining("organization has disabled"),
    }));
    const readiness = await app.inject({ method: "GET", url: "/api/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ runtimes: [{ id: "codex", authenticated: true, available: false }] });
    await app.close();
    store = new AgentStore(dataDir);
    const restarted = createServer({ dataDir, store, engines, logger: false });
    expect((await restarted.inject({ method: "GET", url: "/api/engines" })).json()).toContainEqual(expect.objectContaining({
      id: "codex", authenticated: true, available: false,
      availabilityDetail: expect.stringContaining("organization has disabled"),
    }));
    await restarted.close();
  });

  it("keeps denied work queued and releases it only after an explicit successful provider probe", async () => {
    let providerAvailable = false;
    engines = [{
      adapter,
      authStatus: async () => ({ authenticated: true, detail: "configured login" }),
      availabilityProbe: async () => ({
        available: providerAvailable,
        detail: providerAvailable ? "subscription request accepted" : "subscription inactive",
      }),
    }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Entitlement queue", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Claude-like", engine: "codex" });
    adapter.failureAfterBeforeResponse = "subscription access denied";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "First" } });
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("failed");

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep queued" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getRuns(agent.id)).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/engines/codex/recheck" })).json()).toMatchObject({
      authenticated: true, available: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getRuns(agent.id)).toHaveLength(1);

    providerAvailable = true;
    expect((await app.inject({ method: "POST", url: "/api/engines/codex/recheck" })).json()).toMatchObject({
      authenticated: true, available: true,
    });
    await expect.poll(() => store.getRuns(agent.id).length).toBe(2);
    await app.close();
  });

  it("keeps clean projects available when an older project has projection drift", async () => {
    const project = store.createProject({ label: "Drifted legacy test", hostPath: repoDir });
    vi.spyOn(store, "reconcileCommunicationEvents").mockReturnValue({
      projectId: project.id,
      canonicalEvents: 1,
      linkedProjections: 0,
      missingProjectionEventIds: ["legacy-event"],
      duplicateProjectionEventIds: [],
      orphanProjectionEventIds: [],
      missingProjectionMetadataEventIds: [],
      ok: false,
    });
    const app = createServer({ dataDir, store, engines, logger: false });
    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      canAcceptWork: true,
      checks: { communicationMigration: { ok: false, detail: expect.stringContaining("quarantined project") } },
    });
    await app.close();
  });

  it("validates preset options and snapshots server-resolved guidance into spawned agents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" } })).json<{ id: string }>();
    const invalid = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review", guidance: "Review carefully", engine: "codex", model: "not-real" } });
    expect(invalid.statusCode).toBe(400);
    const invalidEffort = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review", guidance: "Review carefully", engine: "codex", model: "mock-model", effort: "minimal" } });
    expect(invalidEffort.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review trust boundaries", guidance: "Review trust boundaries and capability checks.", engine: "codex", model: "mock-model", effort: "high" } });
    expect(created.statusCode).toBe(201);
    const preset = created.json<{ id: string }>();
    const spawned = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Audit", engine: "spoofed", presetId: preset.id } });
    expect(spawned.statusCode).toBe(200);
    expect(spawned.json<{ activeEngine: string; presetSnapshot: { guidance: string } }>()).toMatchObject({ activeEngine: "codex", presetSnapshot: { guidance: "Review trust boundaries and capability checks." } });
    await app.close();
  });

  it("reports model-specific efforts and rejects incompatible selections before side effects", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Runtime compatibility", hostPath: repoDir });

    const roster = await app.inject({ method: "GET", url: "/api/engines" });
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toContainEqual(expect.objectContaining({
      id: "codex",
      models: [expect.objectContaining({
        id: "mock-model",
        efforts: [{ id: "high", label: "High" }],
      })],
    }));

    const invalidConversation = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Invalid", defaultEngine: "codex", defaultModel: "mock-model", defaultEffort: "minimal" },
    });
    expect(invalidConversation.statusCode).toBe(400);
    expect(store.listConversations(project.id)).toHaveLength(1);

    const conversation = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Valid", defaultEngine: "codex", defaultModel: "mock-model", defaultEffort: "high" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Compatible", engine: "codex", model: "mock-model", effort: "high", conversationId: conversation.id },
    })).json<{ id: string }>();

    const invalidMessage = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "This must not be persisted.", model: "mock-model", effort: "minimal" },
    });
    expect(invalidMessage.statusCode).toBe(400);
    expect(invalidMessage.json()).toEqual({ error: "effort is not available for model" });
    expect(store.getRuns(agent.id)).toHaveLength(0);
    expect(store.getProjectedAgentMessages(agent.id)).toHaveLength(0);

    const models = vi.spyOn(adapter, "listModels").mockReturnValue([
      { id: "mock-model", label: "Mock Model", efforts: [{ id: "high", label: "High" }] },
      { id: "alternate", label: "Alternate", efforts: [{ id: "low", label: "Low" }] },
    ]);
    const efforts = vi.spyOn(adapter, "listEfforts").mockImplementation((model) =>
      model === "alternate" ? [{ id: "low", label: "Low" }] : [{ id: "high", label: "High" }],
    );
    const changedModel = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Use the new model default.", model: "alternate" },
    });
    expect(changedModel.statusCode, changedModel.body).toBe(202);
    await waitForRun(agent.id, 1);
    expect(adapter.seeds.at(-1)).toMatchObject({ model: "alternate", effort: "low" });

    const resetDefaults = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Return to provider defaults.", model: "", effort: "" },
    });
    expect(resetDefaults.statusCode, resetDefaults.body).toBe(202);
    await waitForRun(agent.id, 2);
    expect(adapter.continues.at(-1)).toMatchObject({ model: undefined, effort: undefined });

    models.mockReturnValue([{ id: "", label: "Codex default" }]);
    const unknownCache = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Continue while provider metadata is unavailable." },
    });
    expect(unknownCache.statusCode, unknownCache.body).toBe(202);
    await waitForRun(agent.id, 3);
    expect(adapter.continues.at(-1)).toMatchObject({ model: undefined, effort: undefined });
    models.mockRestore();
    efforts.mockRestore();
    await app.close();
  });

  it("fails closed without crashing when a stored conversation engine is no longer configured", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Stale engine", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Stale", defaultEngine: "removed" });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      payload: { title: "Still stale" },
    });
    expect(updated.statusCode).toBe(400);
    expect(updated.json()).toEqual({ error: "unknown engine" });
    await app.close();
  });

  it("creates conversations, records control messages, and spawns linked agents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
    });
    const project = projectRes.json<{ id: string }>();

    const masterRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: {
        title: "Release control room",
        defaultEngine: "codex",
        defaultModel: "mock-model",
        defaultEffort: "high",
      },
    });
    expect(masterRes.statusCode).toBe(200);
    const conversation = masterRes.json<{ id: string; defaultEngine: string }>();
    expect(conversation.defaultEngine).toBe("codex");

    const messageRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "#broadcast Start an API agent." },
    });
    expect(messageRes.statusCode).toBe(200);
    const recordedMessage = messageRes.json<{ communicationEventId: string }>();
    expect(recordedMessage.communicationEventId).toBeTruthy();
    expect(store.readCommunicationEvents(project.id)).toEqual([
      expect.objectContaining({
        eventId: recordedMessage.communicationEventId,
        intent: "broadcast",
        sender: { kind: "user", userId: "local-operator" },
        text: "Start an API agent.",
      }),
    ]);
    expect(store.listAgents(project.id)).toHaveLength(0);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);

    const agentRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "API agent", engine: "codex", conversationId: conversation.id },
    });
    expect(agentRes.statusCode, agentRes.body).toBe(200);
    const agent = agentRes.json<{ id: string; conversationId: string }>();
    expect(agent.conversationId).toBe(conversation.id);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(
      detailRes.json<{
        messages: { text: string }[];
        agents: { id: string; conversationId: string }[];
      }>(),
    ).toMatchObject({
      messages: [{ text: "#broadcast Start an API agent." }],
      agents: [{ id: agent.id, conversationId: conversation.id }],
    });

    await app.close();
  });

  it("lets the user create an idle subagent for an existing manager and cascade-delete its organization branch", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "User-managed organization", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Organization" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    const childResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Specialist", engine: "codex", managerAgentId: manager.id },
    });
    expect(childResponse.statusCode, childResponse.body).toBe(200);
    const child = childResponse.json<AgentDto>();
    expect(child).toMatchObject({ managerAgentId: manager.id, conversationId: master.id });
    expect(adapter.seeds).toHaveLength(0);

    const grandchild = store.createAgent(project.id, {
      title: "Assistant", engine: "codex", conversationId: master.id, managerAgentId: child.id,
    });
    const deleted = await deleteAgentsWithServerPreview(app, project.id, [manager.id]);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      deleted: true,
      deletedAgentIds: expect.arrayContaining([manager.id, child.id, grandchild.id]),
    });
    expect(store.listAgents(project.id)).toEqual([]);
    await app.close();
  });

  it("returns 409 without deletion when spawn or reparent changes a confirmed cascade", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Deletion races", hostPath: repoDir });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex" });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", managerAgentId: manager.id });
    const outside = store.createAgent(project.id, { title: "Outside", engine: "codex" });

    const beforeSpawn = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`,
      payload: { rootAgentIds: [manager.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const lateChild = store.createAgent(project.id, { title: "Late child", engine: "codex", managerAgentId: child.id });
    const spawnConflict = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: beforeSpawn,
    });
    expect(spawnConflict.statusCode, spawnConflict.body).toBe(409);
    expect(spawnConflict.json()).toMatchObject({ currentPreview: { affectedAgents: expect.arrayContaining([
      expect.objectContaining({ id: lateChild.id }),
    ]) } });
    expect([manager.id, child.id, outside.id, lateChild.id].every((id) => Boolean(store.getAgent(id)))).toBe(true);

    const beforeReparent = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`,
      payload: { rootAgentIds: [manager.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    store.updateAgentOrganization(child.id, { managerAgentId: outside.id });
    const reparentConflict = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: beforeReparent,
    });
    expect(reparentConflict.statusCode, reparentConflict.body).toBe(409);
    expect([manager.id, child.id, outside.id, lateChild.id].every((id) => Boolean(store.getAgent(id)))).toBe(true);

    const deleted = await deleteAgentsWithServerPreview(app, project.id, [manager.id]);
    expect(deleted.json()).toMatchObject({ deleted: true, deletedAgentIds: [manager.id], cleanupPending: false });
    expect(store.getAgent(child.id)?.managerAgentId).toBe(outside.id);
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${outside.id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("returns a durable success receipt when post-commit deletion cleanup needs retry", async () => {
    let failCleanup = true;
    const app = createServer({
      dataDir, store, engines, logger: false,
      agentDeletionCleanupFaults: {
        beforeServerCleanup: () => { if (failCleanup) throw new Error("injected cleanup outage"); },
      },
    });
    const project = store.createProject({ label: "Deletion receipt", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Delete once", engine: "codex" });
    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, payload: { rootAgentIds: [agent.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const committed = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ deleted: true, deletedAgentIds: [agent.id], cleanupPending: true });
    expect(store.getAgent(agent.id)).toBeUndefined();
    const receiptId = committed.json<{ deletionReceiptId: string }>().deletionReceiptId;
    expect(store.sqlite.prepare(`SELECT server_cleanup_completed, last_error FROM agent_deletion_receipts WHERE id = ?`).get(receiptId)).toMatchObject({
      server_cleanup_completed: 0,
      last_error: "injected cleanup outage",
    });

    failCleanup = false;
    const replay = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      deleted: true, deletedAgentIds: [agent.id], deletionReceiptId: receiptId,
      cleanupPending: false, replayed: true,
    });
    await app.close();
  });

  it("keeps Project data intact until every provider runtime termination barrier succeeds", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Project deletion barrier", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Retain until closed", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "finish" } });
    await waitForRun(agent.id);
    persistent.closeFailuresRemaining = 1;

    const blocked = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(blocked.statusCode, blocked.body).toBe(503);
    expect(blocked.json()).toMatchObject({ cleanupPending: true, retryable: true });
    expect(store.getProject(project.id)).toBeDefined();
    expect(store.getAgent(agent.id)).toBeDefined();
    expect(persistent.closed).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ dedupeKey: `runtime-teardown:${agent.id}`, status: "open" }),
      ]));

    const retried = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toEqual({ deleted: true });
    expect(persistent.closed).toBe(2);
    expect(store.getProject(project.id)).toBeUndefined();
    await app.close();
  });

  it("retains a failed provider runtime close for durable deletion cleanup retry", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      agentDeletionCleanupFaults: { runtimeTerminationTimeoutMs: 50 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Provider cleanup retry", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Delete with runtime", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Finish and stay warm" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.starts).toHaveLength(1));
    await vi.waitFor(() => expect(new CoordinationV3Store(store.sqlite).agentSnapshot(agent.id).activeRun).toBeUndefined());
    expect(persistent.closed).toBe(0);
    persistent.closeFailuresRemaining = 1;

    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, payload: { rootAgentIds: [agent.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const committed = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ deleted: true, cleanupPending: true });
    const receiptId = committed.json<{ deletionReceiptId: string }>().deletionReceiptId;
    expect(store.sqlite.prepare(`SELECT server_cleanup_completed, last_error FROM agent_deletion_receipts WHERE id = ?`).get(receiptId)).toMatchObject({
      server_cleanup_completed: 0,
      last_error: expect.stringContaining("simulated provider close failure"),
    });
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>()).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedupeKey: `agent-deletion:${receiptId}:cleanup-pending`, status: "open" }),
    ]));

    const replay = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ deleted: true, cleanupPending: false, replayed: true });
    expect(persistent.closed).toBe(2);
    expect(store.sqlite.prepare(`SELECT server_cleanup_completed, last_error FROM agent_deletion_receipts WHERE id = ?`).get(receiptId)).toEqual({
      server_cleanup_completed: 1,
      last_error: null,
    });
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>()).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedupeKey: `agent-deletion:${receiptId}:cleanup-pending`, status: "resolved" }),
    ]));
    await app.close();
  });

  it("keeps Agent deletion pending until a failed one-shot runtime close is retried", async () => {
    const fallback = new MockAdapter();
    let spawned = false;
    let alive = true;
    let closeAttempts = 0;
    const handle = {
      isAlive: () => alive,
      close: async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("simulated deleted one-shot close failure");
        alive = false;
      },
    };
    const execute = async function* (options: SeedOptions | ContinueOptions): AsyncIterable<AgentEvent> {
      options.onRuntimeSpawned?.(handle);
      spawned = true;
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    engines = [{
      adapter: {
        id: "codex", displayName: "Deleted one-shot runtime",
        listModels: () => fallback.listModels(), listEfforts: () => fallback.listEfforts(),
        apiPriceProfile: () => fallback.apiPriceProfile(), seed: execute, continue: execute,
      },
      authStatus: async () => ({ authenticated: true }),
    }];
    const app = createServer({
      dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 },
      runtimeAuthorityRetryScheduling: {
        setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "One-shot Agent deletion", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Delete active one-shot", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Wait" } });
    await vi.waitFor(() => expect(spawned).toBe(true));

    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, payload: { rootAgentIds: [agent.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const committed = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ deleted: true, cleanupPending: true });
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(alive).toBe(true);
    expect(closeAttempts).toBe(1);

    const replay = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ deleted: true, cleanupPending: false, replayed: true });
    expect(closeAttempts).toBe(2);
    expect(alive).toBe(false);
    await app.close();
  });

  it("keeps Agent deletion pending until an opening provider handle is terminated", async () => {
    const persistent = new SteerableMockAdapter();
    let releaseOpen!: () => void;
    persistent.openBarrier = new Promise<void>((resolve) => { releaseOpen = resolve; });
    persistent.closeFailuresRemaining = 1;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false, communicationV3: { pollMs: 5 },
      runtimeAuthorityRetryScheduling: {
        setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Opening Agent deletion", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Delete while opening", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Open slowly" } });
    await vi.waitFor(() => expect(persistent.opened).toBe(1));

    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, payload: { rootAgentIds: [agent.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const committed = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ deleted: true, cleanupPending: true });
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(persistent.closed).toBe(1);

    releaseOpen();
    await vi.waitFor(() => expect(persistent.closed).toBe(2));
    const replay = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ deleted: true, cleanupPending: false, replayed: true });
    await app.close();
  });

  it("backs off repeated runtime cleanup failures and resets after success", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1, idleTtlMs: 60_000 },
      runtimeAuthorityRetryScheduling: {
        baseDelayMs: 100,
        maxDelayMs: 250,
        random: () => 0.5,
        setTimer: (callback, delayMs) => {
          callbacks.push(callback);
          delays.push(delayMs);
          return { unref() {} } as unknown as NodeJS.Timeout;
        },
        clearTimer: () => undefined,
      },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Runtime retry backoff", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Backoff", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Finish" } });
    await waitForRun(agent.id);
    persistent.closeFailuresRemaining = 3;

    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, payload: { rootAgentIds: [agent.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const committed = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(committed.json()).toMatchObject({ deleted: true, cleanupPending: true });
    expect(delays).toEqual([100]);

    callbacks.shift()!();
    await vi.waitFor(() => expect(delays).toEqual([100, 200]));
    callbacks.shift()!();
    await vi.waitFor(() => expect(delays).toEqual([100, 200, 250]));
    callbacks.shift()!();
    await vi.waitFor(() => expect(persistent.closed).toBe(4));
    expect(callbacks).toHaveLength(0);

    const replay = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(replay.json()).toMatchObject({ deleted: true, cleanupPending: false, replayed: true });
    await app.close();
  });

  it("keeps deletion cleanup and its notification pending until a stubborn provider process exits", async () => {
    const children: ChildProcess[] = [];
    engines = [{ adapter: stubbornProcessAdapter(children, 200), authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      agentDeletionCleanupFaults: { runtimeTerminationTimeoutMs: 20 },
      communicationV3: { pollMs: 5 },
    });
    const project = store.createProject({ label: "Observed deletion cleanup", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Stubborn child", engine: "codex" });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Keep running" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(store.resumeSessionId(agent.id)).toBe("claude-stream-v1"));
    const pid = children[0]!.pid!;
    const preview = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, payload: { rootAgentIds: [agent.id] },
    })).json<{ rootAgentIds: string[]; previewHash: string }>();
    const committed = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ deleted: true, cleanupPending: true });
    expect(processAlive(pid)).toBe(true);
    const receiptId = committed.json<{ deletionReceiptId: string }>().deletionReceiptId;
    expect(store.sqlite.prepare(`SELECT server_cleanup_completed, last_error FROM agent_deletion_receipts WHERE id = ?`).get(receiptId)).toMatchObject({
      server_cleanup_completed: 0,
      last_error: expect.stringMatching(/runtime (interrupt|close) timed out/),
    });
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>()).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedupeKey: `agent-deletion:${receiptId}:cleanup-pending`, status: "open" }),
    ]));

    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 1_000 });
    const replay = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, payload: preview,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ deleted: true, cleanupPending: false, replayed: true });
    expect(store.sqlite.prepare(`SELECT server_cleanup_completed, last_error FROM agent_deletion_receipts WHERE id = ?`).get(receiptId)).toEqual({
      server_cleanup_completed: 1,
      last_error: null,
    });
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).json<Array<{ dedupeKey?: string; status?: string }>>()).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedupeKey: `agent-deletion:${receiptId}:cleanup-pending`, status: "resolved" }),
    ]));
    await app.close();
  });

  it("keeps Project-owned generated artifacts retrievable across rebuild and origin-Agent deletion", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Artifacts", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Artist", engine: "codex" });
    const artifactId = randomUUID();
    const relativePath = `generated/${artifactId}.png`;
    const body = Buffer.from("stable generated bytes");
    const legacyFile = artifactContentPath(dataDir, project.id, agent.id, relativePath);
    const managedFile = managedArtifactContentPath(dataDir, project.id, artifactId);
    mkdirSync(path.dirname(legacyFile), { recursive: true });
    mkdirSync(path.dirname(managedFile), { recursive: true });
    writeFileSync(legacyFile, body);
    writeFileSync(managedFile, body);
    const captured = store.appendEvent(agent.id, {
      type: "generated_artifact", artifactId, executionId: "run-art", path: relativePath,
      sourcePath: "output.png", name: "output.png", mediaType: "image/png", size: body.length,
      visibility: "project", pinned: true,
    });
    store.recordProjectArtifact({
      id: artifactId, projectId: project.id, agentId: agent.id, originAgentId: agent.id,
      executionId: "run-art", kind: "generated_file", path: relativePath, sourcePath: "output.png",
      summary: "output.png", createdAt: captured.ts, mediaType: "image/png", size: body.length,
      visibility: "project", pinned: true,
    });

    store.rebuildProjections();
    expect(readFileSync(legacyFile)).toEqual(body);
    expect((await deleteAgentsWithServerPreview(app, project.id, [agent.id])).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts` })).json<{ items: ArtifactDto[] }>().items)
      .toContainEqual(expect.objectContaining({ id: artifactId, projectId: project.id, originAgentId: agent.id }));
    const downloaded = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${artifactId}/download` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(body);
    await app.close();
  });

  it("serves active generated documents only inside an opaque restricted sandbox", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Sandboxed artifacts", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Visualizer", engine: "codex" });
    const artifactId = randomUUID();
    const relativePath = `generated/${artifactId}.html`;
    const body = Buffer.from("<script>document.body.textContent = 'rendered'</script>");
    const managedFile = managedArtifactContentPath(dataDir, project.id, artifactId);
    mkdirSync(path.dirname(managedFile), { recursive: true });
    writeFileSync(managedFile, body);
    store.recordProjectArtifact({
      id: artifactId, projectId: project.id, agentId: agent.id, originAgentId: agent.id,
      executionId: "run-html", kind: "generated_file", path: relativePath, sourcePath: "report.html",
      summary: "report.html", createdAt: new Date().toISOString(), mediaType: "text/html", size: body.length,
      visibility: "project", pinned: false,
    });
    store.appendEvent(agent.id, { type: "test_result", passed: true, summary: "Accessibility checks passed" });

    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts` })).json<{ items: ArtifactDto[] }>().items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: artifactId, kind: "generated_file" }),
        expect.objectContaining({ agentId: agent.id, kind: "test_report" }),
      ]));

    const preview = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/artifacts/${artifactId}/preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(preview.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(preview.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    expect(preview.headers["referrer-policy"]).toBe("no-referrer");
    expect(preview.rawPayload).toEqual(body);

    const download = await app.inject({
      method: "GET", url: `/api/projects/${project.id}/artifacts/${artifactId}/download`,
    });
    expect(download.headers["content-disposition"]).toMatch(/^attachment/);
    expect(download.headers["content-security-policy"]).not.toContain("sandbox");
    await app.close();
  });

  it("routes a user-created managed agent opening message to the child as Collaboration", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "User-managed opening", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Organization" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    const childResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Specialist",
        engine: "codex",
        managerAgentId: manager.id,
        initialMessage: "Investigate the usability risk and report to your manager.",
      },
    });
    expect(childResponse.statusCode, childResponse.body).toBe(200);
    const child = childResponse.json<AgentDto>();
    await waitForSeedCount(1);

    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      sender: { kind: "user", userId: "local-operator" },
      intent: "collaboration",
      audience: { kind: "agents", agentIds: [child.id] },
      text: "Investigate the usability risk and report to your manager.",
    }));
    expect(store.readCommunicationEvents(project.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ intent: "user_dm" })]),
    );
    expect(store.getConversationDetail(master.id)?.messages).toEqual([]);
    expect(store.getCollaborationViewDetail(master.id)?.messages).toContainEqual(expect.objectContaining({
      role: "user",
      text: "#Specialist Investigate the usability risk and report to your manager.",
    }));
    const prompt = adapter.seeds.find((turn) => turn.agentId === child.id)?.prompt ?? "";
    expect(prompt).toContain(`Your direct manager is the stable agent id ${manager.id}`);
    expect(prompt).toContain("That relationship defines accountability, escalation, creation, and lifecycle ownership; it does not restrict who you may contact.");
    expect(prompt).toContain("You may collaborate directly with any relevant agent in the project");
    expect(prompt).toContain("Common delegation: ponderosa_coordinate({recipientAgentId,text})");
    expect(prompt).toContain("Investigate the usability risk and report to your manager.");
    expect(prompt).not.toContain("Required completion contract for this private user-to-agent request");
    await app.close();
  });

  it("shares Conversation context without copying broadcasts into unrelated agent histories", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Shared default", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Project chat" });
    const observer = store.createAgent(project.id, { title: "Observer", engine: "codex", conversationId: master.id });
    const responsible = store.createAgent(project.id, { title: "Responsible", engine: "codex", conversationId: master.id });

    const shared = await app.inject({
      method: "POST",
      url: `/api/agents/${responsible.id}/messages`,
      payload: {
        text: "Fix the onboarding flow",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(shared.statusCode, shared.body).toBe(202);
    await waitForRun(responsible.id);

    const { communicationEventId: eventId } = shared.json<{ communicationEventId: string }>();
    const runId = store.getRuns(responsible.id).at(-1)!.id;
    expect(store.getCommunicationEvent(project.id, eventId)).toMatchObject({
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Fix the onboarding flow",
    });
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id).find((item) =>
      (item.payload as { communication?: { eventId?: string } }).communication?.eventId === eventId,
    )).toBeTruthy();
    const responsibleDetail = await app.inject({ method: "GET", url: `/api/agents/${responsible.id}` });
    expect(responsibleDetail.json<{ runs: Array<{ id: string; communicationEventId?: string; status: string }> }>().runs)
      .toEqual([expect.objectContaining({ id: runId, status: "completed" })]);
    expect((await app.inject({ method: "GET", url: `/api/agents/${responsible.id}/runs` }))
      .json<Array<{ id: string }>>()).toEqual([expect.objectContaining({ id: runId })]);
    store.appendEvent(responsible.id, { type: "work_item_update", workItemId: "follow-up", executionId: runId, title: "Verify onboarding", status: "done" });
    expect((await app.inject({ method: "GET", url: `/api/agents/${responsible.id}/work-items` }))
      .json<Array<{ executionId?: string; title: string }>>())
      .toEqual([expect.objectContaining({ executionId: runId, title: "Verify onboarding" })]);
    expect(store.getConversationMessages(master.id).filter((message) => message.communicationEventId === eventId)).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Fix the onboarding flow",
      }),
    ]);
    expect(store.getConversationMessages(master.id)
      .find((message) => message.authorAgentId === responsible.id && message.text === "done")).toBeUndefined();
    expect(store.getAgentDetail(responsible.id)?.runOutput).toEqual([
      expect.objectContaining({
        executionId: expect.any(String), kind: "response", text: "done", completed: true,
        fileActivity: [expect.objectContaining({
          path: "a.ts", status: "completed", artifactId: expect.any(String), previewable: true,
        })],
      }),
    ]);
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.sender.kind === "agent" && event.text === "done")).toBe(false);
    expect(store.getMessages(observer.id)).toHaveLength(0);
    expect(store.getMessages(responsible.id)).toHaveLength(0);
    expect(adapter.seeds.filter((turn) => turn.agentId === observer.id)).toHaveLength(0);
    const responsiblePrompt = adapter.seeds.find((turn) => turn.agentId === responsible.id)?.prompt ?? "";
    expect(responsiblePrompt.match(/Fix the onboarding flow/g)).toHaveLength(1);

    const passive = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/messages`,
      payload: { text: "#broadcast Release window is Friday" },
    });
    expect(passive.statusCode).toBe(200);
    expect(store.getConversationMessages(master.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "#broadcast Release window is Friday" }),
    ]));
    expect(adapter.seeds.filter((turn) => turn.agentId === observer.id)).toHaveLength(0);
    expect(store.getMessages(observer.id)).toHaveLength(0);

    // A future agent receives room context only when it runs; its private
    // history starts empty and is never backfilled with organizational prose.
    const futureViaApi = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Future via API", engine: "codex", conversationId: master.id },
    });
    expect(futureViaApi.statusCode).toBe(200);
    const futureId = futureViaApi.json<{ id: string }>().id;
    expect(store.getMessages(futureId)).toHaveLength(0);
    expect(adapter.seeds.filter((turn) => turn.agentId === futureId)).toHaveLength(0);
    await app.close();
  });

  it("isolates reused display names and deleted Conversation context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Isolated rooms", hostPath: repoDir });
    const oldMaster = store.createConversation(project.id, { title: "Deleted room" });
    appendBroadcast(store, project.id, oldMaster.id, "OLD ROOM SECRET MARKER");
    const oldAgent = store.createAgent(project.id, {
      title: "Olympic", engine: "codex", conversationId: oldMaster.id,
    });
    store.appendEvent(oldAgent.id, { type: "session", sessionId: "old-provider-session" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/conversations/${oldMaster.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    const freshMaster = store.createConversation(project.id, { title: "Fresh room" });
    const created = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: { title: "Olympic", engine: "codex", conversationId: freshMaster.id },
    });
    expect(created.statusCode).toBe(200);
    const freshAgent = created.json<{ id: string }>();
    expect(freshAgent.id).not.toBe(oldAgent.id);
    expect(store.resumeSessionId(freshAgent.id)).toBeUndefined();
    expect(store.getMessages(freshAgent.id)).toHaveLength(0);

    const turn = await app.inject({
      method: "POST", url: `/api/agents/${freshAgent.id}/messages`,
      payload: {
        text: "Start completely fresh", sourceChannel: "main",
        sourceConversationId: freshMaster.id, shareWithOrganization: true,
      },
    });
    expect(turn.statusCode, turn.body).toBe(202);
    await waitForRun(freshAgent.id);
    const prompt = adapter.seeds.find((seed) => seed.agentId === freshAgent.id)?.prompt ?? "";
    expect(prompt).toContain("Start completely fresh");
    expect(prompt).not.toContain("OLD ROOM SECRET MARKER");
    expect(adapter.continues.some((entry) => entry.agentId === freshAgent.id)).toBe(false);
    expect(store.readCommunicationProjections(project.id).some((projection) =>
      store.getCommunicationEvent(project.id, projection.eventId)?.conversationId === oldMaster.id)).toBe(false);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("persists one tagged user message and fans it out to every explicit agent", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Group direct", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Friends" });
    const kings = store.createAgent(project.id, { title: "Kings Canyon", engine: "codex", conversationId: master.id });
    const cabrillo = store.createAgent(project.id, { title: "Cabrillo", engine: "codex", conversationId: master.id });
    const olympic = store.createAgent(project.id, { title: "Olympic", engine: "codex", conversationId: master.id });
    const text = "#Kings-Canyon #Cabrillo #Olympic guess what! I just got married!!!!";
    const payload = {
      text,
      recipients: [kings, cabrillo, olympic].map((agent) => ({ agentId: agent.id })),
      idempotencyKey: "wedding-news",
    };

    const sent = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/direct-messages`, payload,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    await Promise.all([waitForRun(kings.id), waitForRun(cabrillo.id), waitForRun(olympic.id)]);

    const userMessages = store.getConversationMessages(master.id).filter((message) => message.role === "user");
    expect(userMessages).toEqual([expect.objectContaining({ text })]);
    for (const handle of ["#Kings-Canyon", "#Cabrillo", "#Olympic"]) {
      expect(userMessages[0]!.text.match(new RegExp(handle, "g"))).toHaveLength(1);
    }
    const communication = store.getCommunicationEvent(project.id, userMessages[0]!.communicationEventId!);
    expect(communication).toMatchObject({
      intent: "user_dm",
      audience: { kind: "user_agents", userId: "local-operator", agentIds: [kings.id, cabrillo.id, olympic.id].sort() },
      text,
    });
    for (const agent of [kings, cabrillo, olympic]) {
      expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventId: communication?.eventId, surface: "direct_agent_audit", projectionKey: agent.id,
          message: expect.objectContaining({ role: "user", renderedText: text }),
        }),
      ]));
      const prompt = adapter.seeds.find((seed) => seed.agentId === agent.id)?.prompt ?? "";
      expect(prompt.match(/guess what! I just got married!!!!/g)).toHaveLength(1);
    }
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#user done")).toHaveLength(0);
    for (const agent of [kings, cabrillo, olympic]) {
      expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
        expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
      ]);
    }

    const replay = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/direct-messages`, payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, messageId: userMessages[0]!.id });
    expect(store.getConversationMessages(master.id).filter((message) => message.role === "user")).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(3);
    await app.close();
  });

  it("projects a user reaction onto its message and privately notifies only the author with reply context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "User emoji reaction", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const observer = store.createAgent(project.id, { title: "Observer", engine: "codex", conversationId: master.id });
    const text = "the user reacted with 🧑🏽‍🚀";
    const communicationEventId = randomUUID();
    store.appendCommunicationEvent({
      eventId: communicationEventId, schemaVersion: 2, projectId: project.id, conversationId: master.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-result" },
      intent: "broadcast", audience: { kind: "organization", organizationId: project.id },
      text: "Original agent result", createdAt: new Date().toISOString(),
    });
    const original = store.appendConversationMessage(
      master.id, { role: "assistant", text: "#broadcast Original agent result" }, author.id,
      "main", undefined, undefined, communicationEventId,
    )!;
    store.appendEvent(author.id, {
      type: "communication_projection", communicationEventId, text: "Original agent result", role: "assistant",
    });
    let reactionReplyStatus: number | undefined;
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: {
          intent: "direct_to_user",
          text: "Reaction acknowledged",
          idempotencyKey: "ack-reaction",
        },
      });
      reactionReplyStatus = response.statusCode;
    };

    const sent = await app.inject({
      method: "POST",
      url: "/api/user-reactions",
      payload: {
        projectId: project.id,
        communicationEventId,
        emoji: "🧑🏽‍🚀",
        idempotencyKey: "reaction-to-author",
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const replay = await app.inject({
      method: "POST", url: "/api/user-reactions",
      payload: { projectId: project.id, communicationEventId, emoji: "🧑🏽‍🚀", idempotencyKey: "reaction-to-author" },
    });
    expect(replay.json()).toMatchObject({ replayed: true, targetAuthorAgentId: author.id });
    await waitForRun(author.id);

    expect(reactionReplyStatus).toBe(200);
    expect(store.getConversationMessages(master.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.id }),
      expect.objectContaining({ role: "assistant", text: "#user Reaction acknowledged", authorAgentId: author.id }),
    ]));
    expect(store.getConversationMessages(master.id).some((message) => message.text === text)).toBe(false);
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${master.id}` });
    expect(detail.json<{ messages: Array<{ reactions?: unknown[] }> }>().messages[0]?.reactions).toEqual([
      { emoji: "🧑🏽‍🚀", count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" }] },
    ]);
    const authorDetail = await app.inject({ method: "GET", url: `/api/agents/${author.id}` });
    expect(authorDetail.json<{ messages: Array<{ reactions?: unknown[] }> }>().messages[0]?.reactions).toEqual([
      { emoji: "🧑🏽‍🚀", count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" }] },
    ]);
    const reactionCommunication = store.readCommunicationEvents(project.id).find((event) => event.text === text);
    expect(reactionCommunication).toMatchObject({
      schemaVersion: 2,
      intent: "user_dm",
      audience: { kind: "user_agent", agentId: author.id },
    });
    expect(store.getMessages(author.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text, communicationEventId: reactionCommunication?.eventId }),
    ]));
    expect(store.getMessages(observer.id).some((message) => message.text === text)).toBe(false);
    expect(adapter.seeds.filter((seed) => seed.agentId === author.id)).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain(text);
    expect(adapter.seeds[0]?.prompt).toContain("Original agent result");
    expect(adapter.seeds.filter((seed) => seed.agentId === observer.id)).toHaveLength(0);
    expect(store.getRuns(author.id).at(-1)?.wakeCause).toBe("direct_message");
    await app.close();
  });

  it("lets a shared-task agent DM a question without publishing an accidental completion", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Question flow", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Planning" });
    const agent = store.createAgent(project.id, { title: "Planner", engine: "codex", conversationId: master.id });
    let dmStatus: number | undefined;
    adapter.responseText = "This ordinary response must be suppressed";
    adapter.beforeResponse = async (opts) => {
      const dm = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: {
          intent: "direct_to_user",
          text: "Which dates should I use?",
          idempotencyKey: "ask-dates",
        },
      });
      dmStatus = dm.statusCode;
    };

    const task = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: {
        text: "Plan my trip",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(task.statusCode, task.body).toBe(202);
    await waitForRun(agent.id);

    expect(dmStatus).toBe(200);
    const messages = store.getConversationMessages(master.id);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "Plan my trip" }),
      expect.objectContaining({ text: "#user Which dates should I use?", authorAgentId: agent.id }),
    ]));
    expect(messages.some((message) => message.text.includes("This ordinary response must be suppressed"))).toBe(false);
    await app.close();
  });

  it("deletes a conversation and preserves its agents as unassigned", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Delete demo", hostPath: repoDir, defaultEngine: "codex" },
    })).json<{ id: string }>();
    const conversation = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Temporary room" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Preserved agent", engine: "codex", conversationId: conversation.id },
    })).json<{ id: string }>();

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ deleted: true });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/agents/${agent.id}` })).json<{ agent: { conversationId?: string } }>().agent.conversationId).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);

    await app.close();
  });

  it("rejects linking an agent to another project's conversation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const firstProjectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "One", hostPath: repoDir, defaultEngine: "codex" },
    });
    const secondProjectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Two", hostPath: repoDir, defaultEngine: "codex" },
    });
    const firstProject = firstProjectRes.json<{ id: string }>();
    const secondProject = secondProjectRes.json<{ id: string }>();
    const masterRes = await app.inject({
      method: "POST",
      url: `/api/projects/${firstProject.id}/conversations`,
      payload: { title: "Project one control room" },
    });
    const conversation = masterRes.json<{ id: string }>();

    const agentRes = await app.inject({
      method: "POST",
      url: `/api/projects/${secondProject.id}/agents`,
      payload: { title: "Wrong project", engine: "codex", conversationId: conversation.id },
    });

    expect(agentRes.statusCode).toBe(400);
    expect(agentRes.json()).toEqual({ error: "conversation does not belong to project" });
    await app.close();
  });

  it("authorizes membership changes and routes a secondary-chat turn", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" } })).json<{ id: string }>();
    const first = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Home" } })).json<{ id: string }>();
    const second = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Review" } })).json<{ id: string }>();
    const agent = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Agent", engine: "codex", conversationId: first.id } })).json<{ id: string }>();
    const membership = await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [first.id, second.id], primaryConversationId: first.id } });
    expect(membership.statusCode).toBe(200);
    expect(membership.json()).toMatchObject({ conversationIds: [first.id, second.id] });
    const turn = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Review this", sourceChannel: "main", sourceConversationId: second.id } });
    expect(turn.statusCode).toBe(202);
    await waitForRun(agent.id);
    expect(store.getConversationMessages(second.id).some((message) => message.authorAgentId === agent.id)).toBe(false);
    expect(store.getConversationMessages(first.id).some((message) => message.authorAgentId === agent.id)).toBe(false);
    expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    await app.close();
  });

  it("seeds first message, then continues with the captured session id", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const room = store.createConversation(project.id, { title: "Scoped directory" });
    store.updateAgentConversationMemberships(agent.id, { conversationIds: [room.id], primaryConversationId: room.id });
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "first", model: "mock-model", effort: "high" },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    await waitForRun(agent.id);
    const firstEventId = first.json<{ communicationEventId: string }>().communicationEventId;
    expect(firstEventId).toBeTruthy();
    expect(store.getMessages(agent.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "first", communicationEventId: firstEventId }),
    ]));
    expect(store.getMessages(agent.id).filter((message) => message.role === "assistant")).toEqual([]);
    expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    expect(store.readCommunicationEvents(store.getAgent(agent.id)!.projectId).some((event) =>
      event.sender.kind === "agent" && event.text === "done")).toBe(false);
    expect(store.reconcileCommunicationEvents(store.getAgent(agent.id)!.projectId)).toMatchObject({ ok: true });

    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    await waitForRun(agent.id, 2);

    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain(`your agent id: ${agent.id}`);
    expect(adapter.seeds[0]?.prompt).toContain("your display name: Agent");
    expect(adapter.seeds[0]?.history).toEqual([]);
    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.resumeSessionId).toBe("sess-1");
    expect(adapter.continues[0]).toMatchObject({ model: "mock-model", effort: "high" });
    expect(store.getRuns(agent.id)).toEqual([
      expect.objectContaining({ model: "mock-model", effort: "high" }),
      expect.objectContaining({ model: "mock-model", effort: "high" }),
    ]);
    const artifacts = store.getArtifacts(agent.id);
    const artifactRes = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/artifacts/${artifacts.find((artifact) => artifact.kind === "diff")?.id}`,
    });
    expect(artifactRes.statusCode).toBe(200);
    expect(artifactRes.json<{ content: string; contentType: string }>()).toMatchObject({
      content: "diff --git a/a.ts b/a.ts\n",
      contentType: "diff",
    });

    store.createAgent(project.id, { title: "New Specialist", engine: "codex", conversationId: room.id });
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "third" },
    });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[1]?.prompt).toContain("[TEAM DIRECTORY | ON-DEMAND REFERENCE]");
    expect(adapter.continues[1]?.prompt).not.toContain("New Specialist");
    await app.close();
  });

  it("retries a provider-confirmed pre-sampling compaction failure from canonical history", async () => {
    const { app, agent } = await createProjectAndAgent();
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "first" },
    });
    await waitForRun(agent.id);

    adapter.mode = "resume_compaction_fail";
    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    await waitForRun(agent.id, 2);

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(2);
    expect(adapter.continues[0]?.prompt).toContain("[TEAM DIRECTORY | ON-DEMAND REFERENCE]");
    expect(store.readEvents(agent.id).some((item) =>
      item.event.type === "error" && item.event.message.includes("pre-sampling compact"),
    )).toBe(false);
    expect(new CoordinationV3Store(store.sqlite).schedulerMetrics().outcomeUnknownRuns).toBe(0);
    expect(store.resumeSessionId(agent.id)).toBe("sess-1");
    await app.close();
  });

  it("does not replay a failed resume after material side effects", async () => {
    const { app, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first" } });
    await waitForRun(agent.id);

    adapter.mode = "material_compaction_fail";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "second" } });
    await vi.waitFor(() => {
      expect(store.readEvents(agent.id).some((item) => item.event.type === "error" && item.event.message.includes("pre-sampling compact"))).toBe(true);
    });

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(1);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "command" && item.event.command === "touch already-ran")).toBe(true);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "error" && item.event.message.includes("pre-sampling compact"))).toBe(true);
    await app.close();
  });

  it("lets an active agent schedule a safe session rollover at turn completion", async () => {
    const { app, agent } = await createProjectAndAgent();
    adapter.mode = "boundary";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "work then refresh" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const url = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_ROLLOVER_URL;
    expect(token).toBeTruthy();
    expect(url).toBe("http://127.0.0.1:8787/api/agent-session/rollover");

    const scheduled = await app.inject({ method: "POST", url: "/api/agent-session/rollover", headers: { authorization: `Bearer ${token}` } });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({ scheduled: true });
    await waitForRun(agent.id);

    expect(store.resumeSessionId(agent.id)).toBeUndefined();
    expect(store.readEvents(agent.id).some((item) => item.event.type === "session_reset" && item.event.reason === "explicit_compaction")).toBe(true);
    await app.close();
  });

  it("explicitly compacts only an idle persisted runtime session", async () => {
    const { app, agent } = await createProjectAndAgent();
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "active" } });
    await waitForSeedCount(1);

    const active = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/compact` });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ retryable: true });
    await cancelAndWait(app, agent.id);

    const compacted = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/compact` });
    expect(compacted.statusCode).toBe(200);
    expect(compacted.json()).toEqual({ compacted: true });
    expect(store.resumeSessionId(agent.id)).toBeUndefined();
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "session_reset"))
      .toEqual([expect.objectContaining({ event: expect.objectContaining({ reason: "explicit_compaction" }) })]);

    const replay = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/compact` });
    expect(replay.json()).toEqual({ compacted: false });
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "session_reset"))
      .toHaveLength(1);
    await app.close();
  });

  it("seeds bounded room context once and sends only the new message on continuation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Release room" });
    appendBroadcast(store, project.id, master.id, "Ship the API change.");
    const agent = store.createAgent(project.id, {
      title: "Aspen",
      engine: "codex",
      conversationId: master.id,
    });

    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Ship the API change.", sourceChannel: "main" },
    });
    await waitForRun(agent.id);

    expect(adapter.seeds[0]?.prompt).toContain("The latest request is a Direct Message");
    expect(adapter.seeds[0]?.prompt).toContain("Do not poll or sleep.");
    expect(adapter.seeds[0]?.prompt).toContain("Manager: Ship the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("[CURRENT REQUEST | ACTION REQUIRED]\nShip the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("- channel: main");
    expect(adapter.seeds[0]?.prompt).toContain("- author: Manager");
    expect(adapter.seeds[0]?.prompt).toContain("- you were tagged: no");

    appendBroadcast(store, project.id, master.id, "#Aspen Is it tested?");
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "#Aspen Is it tested?", sourceChannel: "main" },
    });
    await waitForRun(agent.id, 2);

    expect(adapter.continues[0]?.prompt).not.toContain("Aspen: done");
    expect(adapter.continues[0]?.prompt).toContain("Manager: #Aspen Is it tested?");
    expect(adapter.continues[0]?.prompt).not.toContain("Communication scope is immutable");
    expect(adapter.continues[0]?.prompt).not.toContain("PONDEROSA_DELEGATION_URL");
    expect(adapter.continues[0]?.prompt).toContain("[TEAM DIRECTORY | ON-DEMAND REFERENCE]");
    expect(adapter.continues[0]?.prompt).not.toContain("managed-agent creation bridge");
    expect(adapter.continues[0]?.prompt).toContain("Context injection accounting: room_messages=1; room_characters=20");
    expect(adapter.continues[0]?.prompt).toContain("[CURRENT REQUEST | ACTION REQUIRED]\n#Aspen Is it tested?");
    expect(adapter.continues[0]?.prompt).toContain("- tagged agents: #Aspen");
    expect(adapter.continues[0]?.prompt).toContain("- you were tagged: yes");
    expect(store.getConversationMessages(master.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorAgentId: agent.id, text: "Got it — I’m on it." }),
      ]),
    );
    await app.close();
  });

  it("treats tags on organizational messages as display-only context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Scoped room" });
    const aspen = store.createAgent(project.id, { title: "Aspen", engine: "codex", conversationId: master.id });
    const birch = store.createAgent(project.id, { title: "Birch", engine: "codex", conversationId: master.id });
    appendBroadcast(store, project.id, master.id, "Shared release context.");
    appendBroadcast(store, project.id, master.id, "#Aspen private assignment marker");

    await app.inject({
      method: "POST",
      url: `/api/agents/${birch.id}/messages`,
      payload: { text: "Birch task", sourceChannel: "main" },
    });
    await waitForRun(birch.id);

    expect(adapter.seeds[0]?.prompt).toContain("Shared release context.");
    expect(adapter.seeds[0]?.prompt).toContain("#Aspen private assignment marker");
    expect(adapter.seeds[0]?.prompt).toContain("Context injection accounting: room_messages=2; room_characters=55");

    await app.inject({
      method: "POST",
      url: `/api/agents/${aspen.id}/messages`,
      payload: { text: "Aspen task", sourceChannel: "main" },
    });
    await waitForRun(aspen.id);

    expect(adapter.seeds[1]?.prompt).toContain("Shared release context.");
    expect(adapter.seeds[1]?.prompt).toContain("#Aspen private assignment marker");
    await app.close();
  });

  it("delivers only accepted-session room deltas and does not replay unchanged history", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Incremental room" });
    appendBroadcast(store, project.id, master.id, "seed-only marker");
    const agent = store.createAgent(project.id, { title: "Delta", engine: "codex", conversationId: master.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);
    expect(adapter.seeds[0]?.prompt).toContain("seed-only marker");
    expect(adapter.seeds[0]?.prompt).toContain("Context injection accounting: room_messages=1; room_characters=16");

    appendBroadcast(store, project.id, master.id, "delta marker");
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "delta", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("delta marker");
    expect(adapter.continues[0]?.prompt).not.toContain("seed-only marker");

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "unchanged", sourceChannel: "main" } });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[1]?.prompt).toContain("room_messages=0; room_characters=0");
    expect(adapter.continues[1]?.prompt).not.toContain("delta marker");
    expect(adapter.continues[1]?.prompt).not.toContain("seed-only marker");
    await app.close();
  });

  it("delivers oversized continued-session deltas in bounded FIFO pages", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Canonical context", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Long-running room" });
    appendBroadcast(store, project.id, master.id, "accepted cursor marker");
    const agent = store.createAgent(project.id, { title: "Historian", engine: "codex", conversationId: master.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);
    for (let index = 0; index < 101; index += 1) {
      appendBroadcast(store, project.id, master.id, `canonical delta ${index}`);
    }

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "continue", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("canonical delta 0");
    expect(adapter.continues[0]?.prompt).toContain("canonical delta 39");
    expect(adapter.continues[0]?.prompt).not.toContain("canonical delta 40");
    expect(adapter.continues[0]?.prompt).toContain("[OLDER SCOPED CONTEXT | ON-DEMAND REFERENCE]");
    expect(adapter.continues[0]?.prompt).not.toContain("accepted cursor marker");

    adapter.failNextTurn = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "continue page 2 fails", sourceChannel: "main" } });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[1]?.prompt).not.toContain("canonical delta 39");
    expect(adapter.continues[1]?.prompt).toContain("canonical delta 40");
    expect(adapter.continues[1]?.prompt).toContain("canonical delta 79");
    expect(adapter.continues[1]?.prompt).not.toContain("canonical delta 80");

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "retry page 2", sourceChannel: "main" } });
    await waitForRun(agent.id, 4);
    expect(adapter.continues[2]?.prompt).toContain("canonical delta 40");
    expect(adapter.continues[2]?.prompt).toContain("canonical delta 79");
    expect(adapter.continues[2]?.prompt).not.toContain("canonical delta 80");

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "continue page 3", sourceChannel: "main" } });
    await waitForRun(agent.id, 5);
    expect(adapter.continues[3]?.prompt).not.toContain("canonical delta 79");
    expect(adapter.continues[3]?.prompt).toContain("canonical delta 80");
    expect(adapter.continues[3]?.prompt).toContain("canonical delta 100");
    await app.close();
  });

  it("does not advance context after a failed turn and reseeds a changed session epoch", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Retry room" });
    appendBroadcast(store, project.id, master.id, "original context");
    const agent = store.createAgent(project.id, { title: "Retry", engine: "codex", conversationId: master.id });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);

    appendBroadcast(store, project.id, master.id, "must redeliver");
    adapter.failNextTurn = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "fails", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "retry", sourceChannel: "main" } });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[0]?.prompt).toContain("must redeliver");
    expect(adapter.continues[1]?.prompt).toContain("must redeliver");

    store.appendEvent(agent.id, { type: "session", sessionId: "sess-2" });
    store.appendEvent(agent.id, {
      type: "session_snapshot", sessionId: "sess-2",
      toolContractHash: PROVIDER_TOOL_CONTRACT_HASH, artifactIds: [],
    });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "new epoch", sourceChannel: "main" } });
    await waitForRun(agent.id, 4);
    expect(adapter.continues[2]?.resumeSessionId).toBe("sess-2");
    expect(adapter.continues[2]?.prompt).toContain("original context");
    expect(adapter.continues[2]?.prompt).toContain("original context");
    await app.close();
  });

  it("keeps incremental cursors isolated by visible master room", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const first = store.createConversation(project.id, { title: "First" });
    const second = store.createConversation(project.id, { title: "Second" });
    appendBroadcast(store, project.id, first.id, "first-room secret");
    appendBroadcast(store, project.id, second.id, "second-room secret");
    const agent = store.createAgent(project.id, { title: "Rooms", engine: "codex", conversationId: first.id });
    store.updateAgentConversationMemberships(agent.id, { conversationIds: [first.id, second.id], primaryConversationId: first.id });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "FIRST-ROOM-PRIVATE-REQUEST", sourceChannel: "main", sourceConversationId: first.id } });
    await waitForRun(agent.id);
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "SECOND-ROOM-PRIVATE-REQUEST", sourceChannel: "main", sourceConversationId: second.id } });
    await waitForRun(agent.id, 2);
    expect(adapter.seeds[1]?.prompt).toContain("second-room secret");
    expect(adapter.seeds[1]?.prompt).not.toContain("first-room secret");
    expect(adapter.seeds[1]?.prompt).not.toContain("FIRST-ROOM-PRIVATE-REQUEST");
    expect(adapter.seeds[1]?.resumeSessionId).toBeUndefined();
    await app.close();
  });

  it("records Broadcast lineage for every communication present in exact provider input", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Manifest", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Room" });
    const broadcast = appendBroadcast(store, project.id, conversation.id, "NEBULA-683 shared decision");
    const agent = store.createAgent(project.id, { title: "Reader", engine: "codex", conversationId: conversation.id });
    await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Use current context", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    await waitForRun(agent.id);
    const run = store.getRuns(agent.id)[0]!;
    const input = store.getProviderInput(run.id, true)!;
    expect(input.sourceManifest.schemaVersion).toBe(3);
    expect(input.exactPrompt).toContain("NEBULA-683 shared decision");
    expect(input.sourceManifest.historyMessageCount).toBeGreaterThan(0);
    expect(input.sourceManifest.communicationEventIds).toContain(broadcast.communicationEventId);
    expect(input.sourceManifest.sources).toContainEqual(expect.objectContaining({
      kind: "communication", ref: broadcast.communicationEventId,
    }));
    await app.close();
  });

  it("keeps continued-session history out of exact submitted lineage", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Manifest continuation", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Reader", engine: "codex", conversationId: conversation.id });
    await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "FIRST-LINEAGE-ITEM", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    await waitForRun(agent.id);
    await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "SECOND-LINEAGE-ITEM", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    await waitForRun(agent.id, 2);

    const secondRun = store.getRuns(agent.id)[1]!;
    const input = store.getProviderInput(secondRun.id, true)!;
    expect(input.exactPrompt).toContain("SECOND-LINEAGE-ITEM");
    expect(input.exactPrompt).not.toContain("FIRST-LINEAGE-ITEM");
    expect(input.sourceManifest.schemaVersion).toBe(3);
    if (input.sourceManifest.schemaVersion !== 3) throw new Error("expected V3 manifest");
    expect(input.sourceManifest.sources.filter((source) => source.kind === "history_message")).toEqual([]);
    expect(input.sourceManifest.sources).toContainEqual(expect.objectContaining({
      kind: "policy", delivery: "retained_session",
    }));
    expect(input.sourceManifest.retainedSessionSourceCount).toBe(1);
    await app.close();
  });

  it("reseeds persisted provider sessions with missing or mismatched tool-contract hashes", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Tool contract rollover", hostPath: repoDir });
    const legacy = store.createAgent(project.id, { title: "Legacy", engine: "codex" });
    const mismatched = store.createAgent(project.id, { title: "Mismatched", engine: "codex" });
    store.appendEvent(legacy.id, { type: "session", sessionId: "v341-legacy-session" });
    store.appendEvent(mismatched.id, { type: "session", sessionId: "v342-session" });
    store.appendEvent(mismatched.id, {
      type: "session_snapshot",
      sessionId: "v342-session",
      toolContractHash: "obsolete-contract-hash",
      artifactIds: [],
    });

    for (const [index, agent] of [legacy, mismatched].entries()) {
      const sent = await app.inject({
        method: "POST", url: `/api/agents/${agent.id}/messages`,
        payload: { text: `Use current tools ${index}`, sourceChannel: "main" },
      });
      expect(sent.statusCode, sent.body).toBe(202);
      await waitForRun(agent.id);
      expect(store.readEvents(agent.id).map((entry) => entry.event)).toContainEqual({
        type: "session_reset", reason: "tool_contract_changed",
      });
      expect(store.resumeSessionState(agent.id)).toEqual({
        sessionId: "sess-1",
        toolContractHash: PROVIDER_TOOL_CONTRACT_HASH,
        artifactIds: [],
      });
      const run = store.getRuns(agent.id)[0]!;
      expect(store.getProviderInput(run.id)?.sourceManifest.providerSessionDisposition).toBe("fresh_task");
    }
    expect(adapter.seeds).toHaveLength(2);
    expect(adapter.continues).toHaveLength(0);
    await app.close();
  });

  it("preserves accepted context cursors across a server restart", async () => {
    const firstApp = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Restart room" });
    appendBroadcast(store, project.id, master.id, "before-restart marker");
    const agent = store.createAgent(project.id, { title: "Restart", engine: "codex", conversationId: master.id });
    await firstApp.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);
    await firstApp.close();

    store = new AgentStore(dataDir);
    appendBroadcast(store, project.id, master.id, "after-restart marker");
    const secondApp = createServer({ dataDir, store, engines, logger: false });
    await secondApp.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "resume", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("after-restart marker");
    expect(adapter.continues[0]?.prompt).not.toContain("before-restart marker");
    await secondApp.close();
  });

  it("starts a new conversation agent with its initial message in the creation request", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Release room" });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Acadia",
        engine: "codex",
        conversationId: master.id,
        initialMessage: "Check the first-run path.",
      },
    });

    expect(response.statusCode).toBe(200);
    const agent = response.json<{ id: string }>();
    await waitForRun(agent.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain("[CURRENT REQUEST | ACTION REQUIRED]\nCheck the first-run path.");
    expect(adapter.seeds[0]?.prompt).toContain("[RESPONSE CONTRACT | ACTION REQUIRED]");
    expect(adapter.seeds[0]?.prompt).toContain("ponderosa_message({text:");
    const shared = store.getConversationMessages(master.id).find((message) => message.text === "Check the first-run path.");
    expect(shared).toMatchObject({ role: "user", communicationEventId: expect.any(String) });
    const eventId = shared!.communicationEventId!;
    expect(store.readCommunicationEvents(project.id).filter((event) => event.eventId === eventId)).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        sender: { kind: "user", userId: "local-operator" },
        intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id },
      }),
    ]);
    expect(store.readCommunicationProjections(project.id).filter((projection) => projection.eventId === eventId)
      .map((projection) => [projection.surface, projection.projectionKey])).toEqual(expect.arrayContaining([
        ["conversation", master.id],
      ]));
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("commits staged files with Agent creation and its first Activation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Atomic first send", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Room" });
    const upload = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: { "content-type": "application/octet-stream", "x-ponderosa-media-type": "text/plain", "x-ponderosa-filename": "brief.txt" },
      payload: Buffer.from("first-turn attachment"),
    });
    const draft = upload.json<{ id: string }>();
    const created = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Atomic", engine: "codex", conversationId: conversation.id,
        initialMessage: "Read the brief", draftAttachmentIds: [draft.id],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const agent = created.json<AgentDto>();
    await expect.poll(() => store.readEvents(agent.id).filter((event) => event.event.type === "turn_done").length, { timeout: 3_000 }).toBe(1);
    const message = store.getConversationMessages(conversation.id).find((candidate) => candidate.text === "Read the brief")!;
    expect(message.attachments).toEqual([expect.objectContaining({ name: "brief.txt", state: "associated", agentId: agent.id })]);
    expect(adapter.seeds[0]?.prompt).toContain("Attached images/assets (server-validated local files");
    expect(adapter.seeds[0]?.prompt).toContain(message.attachments![0]!.id);
    expect(new CoordinationV3Store(store.sqlite).pendingActivations(project.id)).toHaveLength(0);
    await app.close();
  });

  it("dispatches a valid collaboration-chat mention without exposing it in the main chat", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Collaboration room" });
    const yosemite = store.createAgent(project.id, {
      title: "Yosemite",
      engine: "codex",
      conversationId: master.id,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "can you review this?", recipientAgentIds: [yosemite.id] },
    });

    expect(response.statusCode).toBe(200);
    await waitForRun(yosemite.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain("Common reply: ponderosa_message({text})");
    expect(adapter.seeds[0]?.prompt).toContain("#Yosemite can you review this?");
    expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "direct_agent_audit", projectionKey: yosemite.id }),
    ]));
    expect(store.getConversationMessages(master.id)).toEqual([]);
    expect(store.getAgentDetail(yosemite.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    expect(store.getConversationMessages(master.id, "collaboration")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "#Yosemite can you review this?" })]),
    );
    await app.close();
  });

  it("dispatches a canonical mention for an agent whose display name contains punctuation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Collaboration room" });
    const wrangell = store.createAgent(project.id, {
      title: "Wrangell-St. Elias",
      engine: "codex",
      conversationId: master.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "can you review this?", recipientAgentIds: [wrangell.id] },
    });

    expect(response.statusCode).toBe(200);
    await waitForRun(wrangell.id);
    expect(adapter.seeds[0]?.prompt).toContain("Common reply: ponderosa_message({text})");
    expect(adapter.seeds[0]?.prompt).toContain("#Wrangell-St-Elias can you review this?");
    expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "direct_agent_audit", projectionKey: wrangell.id }),
    ]));
    await app.close();
  });

  it("delivers an explicit collaboration once to every selected active member", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Broadcast room" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: master.id });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex", conversationId: master.id });
    const archived = store.createAgent(project.id, { title: "Archived", engine: "codex", conversationId: master.id });
    store.updateAgent(archived.id, { archived: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "please report status.", recipientAgentIds: [first.id, second.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ notifiedAgentIds: string[] }>().notifiedAgentIds).toEqual([first.id, second.id]);
    await waitForSeedCount(2);
    expect(adapter.seeds).toHaveLength(2);
    const auditRecipients = store.readCommunicationProjections(project.id)
      .filter((projection) => projection.surface === "direct_agent_audit" && projection.message?.renderedText?.includes("please report status"))
      .map((projection) => projection.projectionKey);
    expect(new Set(auditRecipients)).toEqual(new Set([first.id, second.id]));
    expect(auditRecipients).not.toContain(archived.id);
    const intents = store.getConversationDeliveryIntents(master.id);
    expect(intents.map(({ intent }) => ({ id: intent.targetAgentId, audience: intent.audience }))).toEqual([
      { id: first.id, audience: "mention" },
      { id: second.id, audience: "mention" },
    ]);
    await Promise.all([cancelAndWait(app, first.id), cancelAndWait(app, second.id)]);
    await app.close();
  });

  it("rejects recipient-free collaboration and sends context only after explicit routing", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Private collaboration" });
    const agent = store.createAgent(project.id, {
      title: "Yosemite",
      engine: "codex",
      conversationId: master.id,
    });
    appendBroadcast(store, project.id, master.id, "Main-chat-only deployment plan.");

    const untargeted = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Private review notes that should not reach an agent yet." },
    });
    expect(untargeted.statusCode).toBe(400);
    expect(untargeted.json()).toMatchObject({ error: expect.stringContaining("explicit recipient") });
    expect(adapter.seeds).toHaveLength(0);

    const targeted = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Please review the private notes.", recipientAgentIds: [agent.id] },
    });
    expect(targeted.statusCode).toBe(200);
    await waitForRun(agent.id);

    const prompt = adapter.seeds[0]?.prompt ?? "";
    expect(prompt).not.toContain("Private review notes that should not reach an agent yet.");
    expect(prompt).toContain("#Yosemite Please review the private notes.");
    expect(prompt).toContain("[SHARED PROJECT HISTORY | RELEVANT BACKGROUND]");
    expect(prompt).toContain("Main-chat-only deployment plan.");
    expect(store.getConversationMessages(master.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Main-chat-only deployment plan." })]),
    );
    expect(store.getConversationMessages(master.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Private review notes that should not reach an agent yet." })]),
    );
    await app.close();
  });

  it("keeps an ordinary conversational response in Work log instead of inferring a DM", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Conversational reply", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Team room" });
    appendBroadcast(store, project.id, master.id, "#Greeter sounds good thanks!");
    const greeter = store.createAgent(project.id, { title: "Greeter", engine: "codex", conversationId: master.id });
    adapter.responseText = "You're welcome!";

    await app.inject({
      method: "POST", url: `/api/agents/${greeter.id}/messages`,
      payload: { text: "#Greeter sounds good thanks!", sourceChannel: "main" },
    });
    await waitForRun(greeter.id);

    expect(store.getConversationMessages(master.id).some((message) => message.text.includes("You're welcome!"))).toBe(false);
    expect(store.getMessages(greeter.id).some((message) => message.text.includes("You're welcome!"))).toBe(false);
    expect(store.getAgentDetail(greeter.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "You're welcome!", completed: true }),
    ]);
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.sender.kind === "agent" && event.text === "You're welcome!")).toBe(false);

    const observer = store.createAgent(project.id, { title: "Observer", engine: "codex", conversationId: master.id });
    await app.inject({
      method: "POST", url: `/api/agents/${observer.id}/messages`,
      payload: { text: "What shared context is available?", sourceChannel: "main" },
    });
    await waitForRun(observer.id);
    expect(adapter.seeds[1]?.prompt).not.toContain("#user You're welcome!");
    await app.close();
  });

  it("inherits shared and private reply routes without exposing ordinary output", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Casual conversation", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Trip planning" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: master.id });
    adapter.responseText = "Here are three trip options";
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { text: "Here are three trip options" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((await app.inject({
        method: "POST", url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { text: "Here are three trip options" },
      })).json()).toMatchObject({ replayed: true });
      const secondMaterialReply = await app.inject({
        method: "POST", url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { text: "A different second answer" },
      });
      expect(secondMaterialReply.statusCode).toBe(409);
    };

    const opening = await app.inject({
      method: "POST", url: `/api/agents/${first.id}/messages`,
      payload: {
        text: "Help me plan a trip",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(opening.statusCode, opening.body).toBe(202);
    await waitForRun(first.id);

    const openingPrompt = adapter.seeds.find((turn) => turn.agentId === first.id)?.prompt ?? "";
    expect(openingPrompt).toContain("Ponderosa will publish this shared Project-chat reply as a Broadcast");
    expect(openingPrompt).toContain("[RESPONSE CONTRACT | ACTION REQUIRED]");
    expect(openingPrompt).toContain("Ordinary runtime output remains Work log only");
    expect(openingPrompt).toContain("ponderosa_message");
    expect(openingPrompt).toContain("ponderosa_message({text:");
    expect(store.getConversationMessages(master.id)).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Here are three trip options", authorAgentId: first.id }),
    );
    expect(store.getConversationMessages(master.id).some((message) => message.text === "#broadcast Here are three trip options")).toBe(false);

    const privateAgent = store.createAgent(project.id, { title: "Private", engine: "codex", conversationId: master.id });
    adapter.responseText = "Private implementation detail";
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { text: "Private implementation detail" },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const privateTurn = await app.inject({
      method: "POST", url: `/api/agents/${privateAgent.id}/messages`,
      payload: { text: "Inspect a private issue", sourceChannel: "main", sourceConversationId: master.id },
    });
    expect(privateTurn.statusCode, privateTurn.body).toBe(202);
    await waitForRun(privateAgent.id);
    const privatePrompt = adapter.seeds.find((turn) => turn.agentId === privateAgent.id)?.prompt ?? "";
    expect(privatePrompt).toContain("Ponderosa will keep this reply private to the user and this Agent");
    expect(privatePrompt).toContain("ponderosa_message({text:");
    expect(privatePrompt).not.toContain("publish this shared Project-chat reply as a Broadcast");
    expect(store.getConversationMessages(master.id).some((message) => message.text === "Private implementation detail")).toBe(false);
    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      intent: "user_dm", text: "Private implementation detail",
      audience: { kind: "user_agent", userId: "local-operator", agentId: privateAgent.id },
    }));

    const next = store.createAgent(project.id, { title: "Next", engine: "codex", conversationId: master.id });
    adapter.responseText = "Let's continue";
    const followUp = await app.inject({
      method: "POST", url: `/api/agents/${next.id}/messages`,
      payload: {
        text: "I can leave Friday",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(followUp.statusCode, followUp.body).toBe(202);
    await waitForRun(next.id);

    const prompt = adapter.seeds.find((turn) => turn.agentId === next.id)?.prompt ?? "";
    expect(prompt).toContain("Manager: Help me plan a trip");
    expect(prompt).toContain("First: Here are three trip options");
    expect(prompt).not.toContain("Inspect a private issue");
    expect(prompt).not.toContain("Private implementation detail");
    expect(prompt.match(/I can leave Friday/g)).toHaveLength(1);
    expect(store.getAgentDetail(privateAgent.id)?.runOutput).toEqual([
      expect.objectContaining({ text: "Private implementation detail", completed: true }),
    ]);
    await app.close();
  });

  it("supports concise delegate, report, ask, and fail-closed reply contracts", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Facade", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Facade team" });
    const requester = store.createAgent(project.id, { title: "Requester", engine: "codex", conversationId: conversation.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: conversation.id });

    expect((await app.inject({
      method: "POST", url: `/api/agents/${requester.id}/messages`,
      payload: { text: "Delegate this", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const requesterRuntime = persistent.openedOptions[0]!;
    const delegated = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_coordinate", arguments: { recipientAgentId: recipient.id, text: "Return the facade result." },
    });
    expect(delegated.success, delegated.text).toBe(true);
    const delegation = JSON.parse(delegated.text) as { requestIds: string[]; joinId: string; replayed: boolean };
    expect(delegation).toMatchObject({ requestIds: [expect.any(String)], joinId: expect.any(String), replayed: false });
    expect(store.sqlite.prepare("SELECT lifetime_kind, deadline_at FROM coordination_requests WHERE id = ?").get(delegation.requestIds[0]!))
      .toEqual({ lifetime_kind: "indefinite", deadline_at: null });
    const replay = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_coordinate", arguments: { recipientAgentId: recipient.id, text: "Return the facade result." },
    });
    expect(JSON.parse(replay.text)).toMatchObject({ requestIds: delegation.requestIds, joinId: delegation.joinId, replayed: true });

    persistent.completeTurn(0);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const recipientRuntime = persistent.openedOptions[1]!;
    const ambiguousReply = await recipientRuntime.handleDynamicToolCall!({ name: "ponderosa_message", arguments: { text: "Wrong channel" } });
    expect(ambiguousReply.success).toBe(false);
    expect(JSON.parse(ambiguousReply.text)).toMatchObject({ error: expect.stringContaining("no unambiguous reply route") });
    const question = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request", arguments: { question: "Which output format should I use?" },
    });
    expect(question.success, question.text).toBe(true);
    expect(JSON.parse(question.text)).toMatchObject({ requestId: delegation.requestIds[0], state: "awaiting_answer" });
    const questionUpdate = store.sqlite.prepare(`
      SELECT id, kind FROM coordination_request_updates
      WHERE request_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(delegation.requestIds[0]!) as { id: string; kind: string };
    expect(questionUpdate.kind).toBe("question");
    persistent.completeTurn(1);
    await vi.waitFor(() => expect(persistent.starts.length).toBeGreaterThanOrEqual(3));
    const requesterQuestionRuntime = persistent.openedOptions.filter((options) => options.agentId === requester.id).at(-1)!;
    const answer = await requesterQuestionRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { kind: "answer", text: "Use Markdown.", inReplyToUpdateId: questionUpdate.id },
    });
    expect(answer.success, answer.text).toBe(true);
    persistent.completeTurn(persistent.openedOptions.lastIndexOf(requesterQuestionRuntime));
    await vi.waitFor(() => expect(persistent.starts.length).toBeGreaterThanOrEqual(4));
    const resumedRecipientRuntime = persistent.openedOptions.filter((options) => options.agentId === recipient.id).at(-1)!;
    const report = await resumedRecipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request", arguments: { text: "Facade result complete." },
    });
    expect(report.success, report.text).toBe(true);
    expect(JSON.parse(report.text)).toMatchObject({ requestId: delegation.requestIds[0], state: "completed" });
    const reportReplay = await resumedRecipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request", arguments: { text: "Facade result complete." },
    });
    expect(JSON.parse(reportReplay.text)).toMatchObject({ requestId: delegation.requestIds[0], state: "completed" });
    const asked = await resumedRecipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_decision", arguments: { question: "What should happen next?" },
    });
    expect(asked.success, asked.text).toBe(true);
    expect(JSON.parse(asked.text)).toMatchObject({ mode: "text", question: "What should happen next?" });
    const askedReplay = await resumedRecipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_decision", arguments: { question: "What should happen next?" },
    });
    expect(JSON.parse(askedReplay.text)).toMatchObject({ id: JSON.parse(asked.text).id });
    await app.close();
  });

  it("preserves an inherited user reply route across a callback continuation", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 1_000 },
      executionLeaseScheduling: { leaseMs: 5_000, heartbeatMs: 100 },
    });
    const project = store.createProject({ label: "Continuation reply", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const worker = store.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    await app.inject({
      method: "POST", url: `/api/agents/${manager.id}/messages`,
      payload: { text: "Ask the worker", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const opening = persistent.openedOptions[0]!;
    const delegated = await opening.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: { recipientAgentId: worker.id, text: "Return the answer", completionMode: "callback" },
    });
    expect(delegated.success, delegated.text).toBe(true);
    persistent.completeTurn(0);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const workerRuntime = persistent.openedOptions[1]!;
    const unauthorizedReply = await workerRuntime.handleDynamicToolCall!({
      name: "ponderosa_message", arguments: { text: "This must not inherit the manager's user route" },
    });
    expect(unauthorizedReply.success).toBe(false);
    expect(unauthorizedReply.text).toContain("no unambiguous reply route");
    const completed = await workerRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request", arguments: { text: "Worker answer" },
    });
    expect(completed.success, completed.text).toBe(true);
    persistent.completeTurn(1);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(3));
    const continuation = persistent.openedOptions[2]!;
    expect(continuation.agentId).toBe(manager.id);
    const reply = await continuation.handleDynamicToolCall!({
      name: "ponderosa_message", arguments: { text: "Final answer to the user" },
    });
    expect(reply.success, reply.text).toBe(true);
    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      intent: "user_dm", text: "Final answer to the user",
      sender: { kind: "agent", agentId: manager.id, executionId: expect.any(String) },
      audience: { kind: "user_agent", userId: "local-operator", agentId: manager.id },
    }));
    persistent.completeTurn(2);
    await app.close();
  });

  it("lets a manager retrieve an artifact-backed child result through the continuation Activation", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 2, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Large child result", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const worker = store.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${manager.id}/messages`,
      payload: { text: "Get the full result", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const delegated = await persistent.openedOptions[0]!.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: { recipientAgentId: worker.id, text: "Return the full result", completionMode: "callback" },
    });
    expect(delegated.success, delegated.text).toBe(true);
    persistent.completeTurn(0);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const fullResult = `Result\n${"r".repeat(10_100)}`;
    const reported = await persistent.openedOptions[1]!.handleDynamicToolCall!({
      name: "ponderosa_update_request", arguments: { text: fullResult },
    });
    expect(reported.success, reported.text).toBe(true);
    const resultRef = JSON.parse(reported.text).resultRef as string;
    expect(resultRef).toMatch(/^ponderosa:\/\/artifact\/text-/);
    persistent.completeTurn(1);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(3));
    expect(persistent.starts[2]?.prompt).toContain(resultRef);
    expect(persistent.starts[2]?.prompt).not.toContain(fullResult);
    const countsBefore = store.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM scheduler_runs) AS runs,
      (SELECT COUNT(*) FROM agent_activations) AS activations`).get();
    const retrieved = await persistent.openedOptions[2]!.handleDynamicToolCall!({
      name: "ponderosa_result", arguments: { refs: [resultRef], maxBytes: 262_144 },
    });
    expect(retrieved.success, retrieved.text).toBe(true);
    expect(JSON.parse(retrieved.text)).toMatchObject({
      items: [{ ref: resultRef, complete: true, content: fullResult }],
    });
    expect(store.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM scheduler_runs) AS runs,
      (SELECT COUNT(*) FROM agent_activations) AS activations`).get()).toEqual(countsBefore);
    persistent.completeTurn(2);
    await app.close();
  });

  it("retrieves reachable durable results through signed bounded pagination without scheduler mutation", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const project = store.createProject({ label: "Result retrieval", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const activation = new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: "large-result",
      projectId: project.id,
      sender: { kind: "system", component: "qualification" },
      intent: "qualification_result",
      audience: { agentId: agent.id },
      payload: { result: "é".repeat(40_000), exact: true },
      scopeKey: `conversation:${conversation.id}`,
      activation: {
        agentId: agent.id, kind: "qualification_result", priority: 60,
        dispatchPolicy: "next_run", promptClass: "coordination",
      },
    });
    const ref = `ponderosa://activation/${activation.activationId}`;
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1, leaseMs: 1_000 },
    });
    await app.ready();
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;
    expect(runtime.dynamicTools?.find((tool) => tool.name === "ponderosa_coordinate")?.inputSchema.properties)
      .not.toHaveProperty("inspectActivationIds");
    expect(persistent.starts[0]?.prompt).toContain(`fullResultRef: ${ref}`);
    expect(persistent.starts[0]?.prompt).toContain("ponderosa_result({refs:[fullResultRef]})");
    const countsBefore = store.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM scheduler_runs) AS runs,
      (SELECT COUNT(*) FROM agent_activations) AS activations,
      (SELECT COUNT(*) FROM coordination_requests) AS requests,
      (SELECT COUNT(*) FROM coordination_joins) AS joins`).get();
    const first = await runtime.handleDynamicToolCall!({
      name: "ponderosa_result", arguments: { refs: [ref], maxBytes: 4096 },
    });
    expect(first.success, first.text).toBe(true);
    const firstPage = JSON.parse(first.text) as {
      items: Array<{ ref: string; range: { start: number; end: number }; complete: boolean; content: string }>;
      nextCursor: string;
    };
    expect(firstPage.items).toEqual([expect.objectContaining({
      ref, range: { start: 0, end: expect.any(Number) }, complete: false,
    })]);
    expect(Buffer.byteLength(firstPage.items[0]!.content, "utf8")).toBeLessThanOrEqual(4096);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const replay = await runtime.handleDynamicToolCall!({
      name: "ponderosa_result", arguments: { refs: [ref], cursor: firstPage.nextCursor },
    });
    expect(replay.success, replay.text).toBe(true);
    const replayAgain = await runtime.handleDynamicToolCall!({
      name: "ponderosa_result", arguments: { refs: [ref], cursor: firstPage.nextCursor },
    });
    expect(replayAgain.text).toBe(replay.text);
    const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalCharacter = firstPage.nextCursor.at(-1)!;
    const alternateFinalCharacter = base64urlAlphabet[base64urlAlphabet.indexOf(finalCharacter) ^ 1]!;
    const nonCanonicalCursor = `${firstPage.nextCursor.slice(0, -1)}${alternateFinalCharacter}`;
    expect(Buffer.from(nonCanonicalCursor.split(".")[1]!, "base64url"))
      .toEqual(Buffer.from(firstPage.nextCursor.split(".")[1]!, "base64url"));
    const tampered = await runtime.handleDynamicToolCall!({
      name: "ponderosa_result", arguments: { refs: [ref], cursor: nonCanonicalCursor },
    });
    expect(tampered.success).toBe(false);
    expect(JSON.parse(tampered.text)).toMatchObject({ error: expect.stringContaining("tampered") });
    expect(store.sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM scheduler_runs) AS runs,
      (SELECT COUNT(*) FROM agent_activations) AS activations,
      (SELECT COUNT(*) FROM coordination_requests) AS requests,
      (SELECT COUNT(*) FROM coordination_joins) AS joins`).get()).toEqual(countsBefore);
    persistent.completeTurn(0);
    await app.close();
  });

  it("sanitizes every Run steering identifier before artifact creation and deduplicates an equal document", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1, leaseMs: 1_000 },
    });
    const project = store.createProject({ label: "Sanitized artifact", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, { title: "Writer", engine: "codex", conversationId: conversation.id });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Write the report", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runId = store.sqlite.prepare(`SELECT id FROM scheduler_runs WHERE agent_id = ? AND status = 'running'`).get(agent.id) as { id: string };
    const injections = store.sqlite.prepare(`SELECT id FROM scheduler_prompt_injections WHERE run_id = ? ORDER BY sequence`).all(runId.id) as Array<{ id: string }>;
    expect(injections.length).toBeGreaterThan(0);
    const staleOrCurrentId = injections[0]!.id;
    const raw = `Report references ${staleOrCurrentId}\r\n${"x".repeat(10_100)}`;
    const published = await persistent.openedOptions[0]!.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: {
        text: raw,
        document: { title: `Report ${staleOrCurrentId}`, mediaType: "text/markdown", content: raw },
      },
    });
    expect(published.success, published.text).toBe(true);
    const result = JSON.parse(published.text) as { eventId: string; resultRef: string };
    const event = store.getCommunicationEvent(project.id, result.eventId)!;
    expect(event.text).toBe(result.resultRef.replace("ponderosa://artifact/", "Full response: ponderosa://artifact/"));
    expect(event.document?.title).toBe("Report [steering reference]");
    const artifactRows = new CoordinationV3Store(store.sqlite).runtimeArtifacts("communication", result.eventId);
    expect(artifactRows).toHaveLength(1);
    const body = readFileSync(managedArtifactContentPath(dataDir, project.id, artifactRows[0]!.id), "utf8");
    expect(body).toContain("[steering reference]\n");
    expect(body).not.toContain(staleOrCurrentId);
    expect(JSON.stringify(event)).not.toContain(staleOrCurrentId);
    expect((store.sqlite.prepare(`SELECT payload_json FROM runtime_communications WHERE id = ?`).get(result.eventId) as { payload_json: string }).payload_json)
      .not.toContain(staleOrCurrentId);
    persistent.completeTurn(0);
    await app.close();
  });

  it("repairs an artifact communication on exact retry after SQLite committed before projection", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let failProjection = true;
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1, leaseMs: 1_000 },
      messageLifecycleFaults: {
        afterCommunicationArtifactCommit: ({ kind }) => {
          if (kind === "communication" && failProjection) {
            failProjection = false;
            throw new Error("simulated crash after SQLite commit");
          }
        },
      },
    });
    const project = store.createProject({ label: "Artifact retry", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, { title: "Writer", engine: "codex", conversationId: conversation.id });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Write the long result", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const full = "z".repeat(10_100);
    const call = { name: "ponderosa_message", arguments: { text: full } };
    const first = await persistent.openedOptions[0]!.handleDynamicToolCall!(call);
    expect(first.success).toBe(false);
    const runtimeRow = store.sqlite.prepare(`SELECT owner_id AS id FROM runtime_artifacts WHERE project_id = ?`).get(project.id) as { id: string };
    expect(new CoordinationV3Store(store.sqlite).runtimeArtifacts("communication", runtimeRow.id)).toHaveLength(1);
    expect(store.getCommunicationEvent(project.id, runtimeRow.id)).toBeUndefined();

    const retry = await persistent.openedOptions[0]!.handleDynamicToolCall!(call);
    expect(retry.success, retry.text).toBe(true);
    expect(JSON.parse(retry.text)).toMatchObject({ eventId: runtimeRow.id, replayed: true, resultRef: expect.stringMatching(/^ponderosa:\/\/artifact\//) });
    expect(store.getCommunicationEvent(project.id, runtimeRow.id)).toMatchObject({
      eventId: runtimeRow.id,
      text: expect.stringMatching(/^Full response: ponderosa:\/\/artifact\//),
    });
    persistent.completeTurn(0);
    await app.close();
  });

  it("gives a Trigger root a silent-by-default direct user reply route", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const project = store.createProject({ label: "Trigger reply", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Automation" });
    const agent = store.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.createTriggerDefinition({
      id: "reply", projectId: project.id, conversationId: conversation.id, agentId: agent.id,
      name: "Reply", instructions: "Notify the user only for a material result.",
      sourceKind: "webhook", sourceConfig: { replayWindowSeconds: 300 },
    });
    coordination.recordTriggerOccurrence({
      triggerId: "reply", occurrenceKey: "one", payload: {}, provenance: { source: "test" },
    });
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 1, leaseMs: 1_000 },
    });
    await app.ready();
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    expect(store.readCommunicationEvents(project.id)).toHaveLength(0);
    const reply = await persistent.openedOptions[0]!.handleDynamicToolCall!({
      name: "ponderosa_message", arguments: { text: "Trigger completed materially." },
    });
    expect(reply.success, reply.text).toBe(true);
    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      intent: "user_dm", text: "Trigger completed materially.",
      sender: { kind: "agent", agentId: agent.id, executionId: expect.any(String) },
    }));
    persistent.completeTurn(0);
    await app.close();
  });

  it("creates one streaming aggregate Join for common fan-out and validates explicit completion modes", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 1_000 },
      executionLeaseScheduling: { leaseMs: 5_000, heartbeatMs: 100 },
    });
    const project = store.createProject({ label: "Aggregate", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: conversation.id });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex", conversationId: conversation.id });
    await app.inject({
      method: "POST", url: `/api/agents/${manager.id}/messages`,
      payload: { text: "Delegate both checks", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;
    const fanout = await runtime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        delegations: [
          { recipientAgentId: first.id, text: "Check A" },
          { recipientAgentId: second.id, text: "Check B" },
        ],
      },
    });
    expect(fanout.success, fanout.text).toBe(true);
    const fanoutResult = JSON.parse(fanout.text) as { requestIds: string[]; joinId: string };
    expect(fanoutResult.requestIds).toHaveLength(2);
    expect(store.sqlite.prepare(`
      SELECT wake_policy, state FROM coordination_joins WHERE id = ?
    `).get(fanoutResult.joinId)).toEqual({ wake_policy: "each_result", state: "open" });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM coordination_join_members WHERE join_id = ?
    `).get(fanoutResult.joinId)).toEqual({ count: 2 });

    const record = await runtime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: { recipientAgentId: first.id, text: "Inventory only", completionMode: "record" },
    });
    expect(record.success, record.text).toBe(true);
    const recordResult = JSON.parse(record.text) as { requestIds: string[]; joinId?: string };
    expect(recordResult.joinId).toBeUndefined();
    expect(store.sqlite.prepare(`SELECT json_extract(payload_json, '$.completionMode') AS mode
      FROM coordination_requests WHERE id = ?`).get(recordResult.requestIds[0]!)).toEqual({ mode: "record" });

    const malformedAnswer = await runtime.handleDynamicToolCall!({
      name: "ponderosa_update_request", arguments: { kind: "answer", text: "Missing correlation" },
    });
    expect(malformedAnswer.success).toBe(false);
    expect(JSON.parse(malformedAnswer.text)).toMatchObject({ error: expect.stringContaining("inReplyToUpdateId") });
    await app.close();
  });

  it("runs correlated V3 work through exactly three coordination tools and a fenced activation cycle", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 1_000 },
      executionLeaseScheduling: { leaseMs: 5_000, heartbeatMs: 100 },
    });
    const project = store.createProject({ label: "V3", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const requester = store.createAgent(project.id, { title: "Requester", engine: "codex", conversationId: conversation.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: conversation.id });

    const started = await app.inject({
      method: "POST", url: `/api/agents/${requester.id}/messages`,
      payload: { text: "Coordinate the review", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ queued: true, position: 1 });
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const requesterRuntime = persistent.openedOptions[0]!;
    expect(requesterRuntime.dynamicTools?.map((tool) => tool.name).filter((name) => [
      "ponderosa_coordinate", "ponderosa_update_request", "ponderosa_message",
    ].includes(name))).toEqual([
      "ponderosa_coordinate", "ponderosa_update_request", "ponderosa_message",
    ]);
    expect(requesterRuntime.dynamicTools?.map((tool) => tool.name)).toContain("ponderosa_browser_open");
    expect(requesterRuntime.dynamicTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "ponderosa_team_directory", "ponderosa_context", "ponderosa_result",
    ]));
    const providerDirectory = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_team_directory", arguments: { agentId: recipient.id },
    });
    expect(providerDirectory.success, providerDirectory.text).toBe(true);
    expect(JSON.parse(providerDirectory.text)).toMatchObject({ agentId: recipient.id });
    const providerContext = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_context", arguments: { limit: 10 },
    });
    expect(providerContext.success, providerContext.text).toBe(true);
    expect(JSON.parse(providerContext.text)).toMatchObject({
      scope: { conversationId: conversation.id }, messages: expect.any(Array),
    });
    expect(requesterRuntime.dynamicTools?.find((tool) => tool.name === "ponderosa_update_request")?.inputSchema.anyOf)
      .toEqual([{ required: ["text"] }, { required: ["question"] }, { required: ["kind"] }]);
    expect(requesterRuntime.dynamicTools?.some((tool) => tool.name.includes("wait") || tool.name.includes("spawn"))).toBe(false);

    const invalidDeadline = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "invalid-deadline",
        requests: [{ requestId: "invalid-deadline-request", recipientAgentId: recipient.id, text: "Never create", lifetime: { kind: "indefinite" } }],
        join: { id: "invalid-deadline-join", mode: "all", deadline: "2026-07-17T00:00:00.000Z" },
      },
    });
    expect(invalidDeadline.success).toBe(false);
    expect(JSON.parse(invalidDeadline.text)).toMatchObject({ error: expect.stringContaining("deadlineAt") });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM coordination_requests WHERE id = 'invalid-deadline-request'").get())
      .toEqual({ count: 0 });

    const coordinated = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "review-cycle",
        requests: [{
          requestId: "review-request",
          recipientAgentId: recipient.id,
          text: "Review the change and report a terminal outcome.",
          lifetime: { kind: "indefinite" },
        }],
        join: { id: "review-join", mode: "all" },
      },
    });
    expect(coordinated.success, coordinated.text).toBe(true);
    expect(JSON.parse(coordinated.text)).toMatchObject({
      requestIds: ["review-request"], joinId: "review-join", replayed: false,
    });

    persistent.completeTurn(0);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const recipientRuntime = persistent.openedOptions[1]!;
    await vi.waitFor(() => expect(persistent.starts.some((turn) => turn.prompt.includes("review-request"))).toBe(true));
    // Prove the scheduler renews an active provider Run beyond two lease
    // periods without relying on sub-100 ms runner scheduling.
    await sleep(2_100);
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased', 'running')
    `).get()).toEqual({ count: 1 });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
    expect(store.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'review-request'").get())
      .toEqual({ state: "open" });
    const mistyped = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: {
        requestId: "review-requesx",
        updateId: "review-complete",
        kind: "completed",
        text: "Review passed.",
      },
    });
    expect(mistyped.success).toBe(false);
    expect(JSON.parse(mistyped.text)).toMatchObject({
      error: "request not found",
      currentRequestIds: ["review-request"],
      hint: "Retry without requestId to target the current run's attached request",
    });
    const earlyOutcomeMessage = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: {
        intent: "collaboration",
        recipientAgentIds: [requester.id],
        text: "Audit copy sent before the terminal Request update.",
        idempotencyKey: "early-review-outcome",
      },
    });
    expect(earlyOutcomeMessage.success, earlyOutcomeMessage.text).toBe(true);
    expect(JSON.parse(earlyOutcomeMessage.text)).toMatchObject({ passiveRecipientAgentIds: [requester.id] });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'ordinary_message' AND agent_id = ?
    `).get(requester.id)).toEqual({ count: 0 });
    const completed = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: {
        updateId: "review-complete",
        kind: "completed",
        text: "Review passed.",
      },
    });
    expect(completed.success, completed.text).toBe(true);
    expect(JSON.parse(completed.text)).toMatchObject({ requestId: "review-request", state: "completed" });
    const duplicateOutcomeMessage = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: {
        intent: "collaboration",
        recipientAgentIds: [requester.id],
        text: "Duplicate audit copy: review passed.",
        idempotencyKey: "duplicate-review-outcome",
      },
    });
    expect(duplicateOutcomeMessage.success, duplicateOutcomeMessage.text).toBe(true);
    expect(JSON.parse(duplicateOutcomeMessage.text)).toMatchObject({
      passiveRecipientAgentIds: [requester.id],
    });
    expect(store.sqlite.prepare(`
      SELECT actionable FROM runtime_communications
      WHERE json_extract(payload_json, '$.idempotencyKey') = 'duplicate-review-outcome'
    `).get()).toEqual({ actionable: 0 });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'ordinary_message' AND agent_id = ?
    `).get(requester.id)).toEqual({ count: 0 });
    persistent.completeTurn(1);

    await vi.waitFor(() => expect(persistent.starts.some((turn) =>
      turn.prompt.includes("coordination_join_satisfied") && turn.prompt.includes("Review passed."),
    )).toBe(true));
    const sqlite = store.sqlite;
    expect(sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'review-request'").get()).toEqual({ state: "completed" });
    expect(sqlite.prepare("SELECT state FROM coordination_joins WHERE id = 'review-join'").get()).toEqual({ state: "satisfied" });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased', 'running', 'completed')
    `).get()).toEqual({ count: 3 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'coordination_join_satisfied'
    `).get()).toEqual({ count: 1 });

    const metrics = (await app.inject({ method: "GET", url: "/api/communication-v3/metrics" })).json<{
      storage: { outcomeUnknownRuns: number }; scheduler: { acceptedRuns: number };
    }>();
    expect(metrics.storage.outcomeUnknownRuns).toBe(0);
    expect(metrics.scheduler.acceptedRuns).toBeGreaterThanOrEqual(2);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      ok: true,
      missingProjectionMetadataEventIds: [],
    });

    const openedBeforeSecond = persistent.openedOptions.length;
    const requesterSessionIndex = persistent.openedOptions.map((option) => option.agentId).lastIndexOf(requester.id);
    const second = new CoordinationV3Store(store.sqlite).coordinate({
      projectId: project.id,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "second-review-cycle",
      requests: [{
        requestId: "second-review-request",
        recipientAgentId: recipient.id,
        payload: { text: "Review README.md independently and report a terminal outcome." },
        lifetime: { kind: "indefinite" },
      }],
    });
    expect(second).toMatchObject({ requestIds: ["second-review-request"], replayed: false });
    persistent.completeTurn(requesterSessionIndex);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(openedBeforeSecond + 1));
    expect(store.readEvents(recipient.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({
        type: "session_reset", reason: "request_context_rollover",
      }) }),
    ]));
    const secondRecipientSessionIndex = persistent.openedOptions.length - 1;
    expect(persistent.openedOptions[secondRecipientSessionIndex]).toMatchObject({
      agentId: recipient.id, resumeSessionId: undefined,
    });
    expect(persistent.closed).toBeGreaterThanOrEqual(1);
    const secondRecipientRuntime = persistent.openedOptions[secondRecipientSessionIndex]!;
    const secondCompleted = await secondRecipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { updateId: "second-review-complete", kind: "completed", text: "README review passed." },
    });
    expect(secondCompleted.success, secondCompleted.text).toBe(true);
    persistent.completeTurn(secondRecipientSessionIndex);
    await vi.waitFor(() => expect(store.sqlite.prepare(
      "SELECT state FROM coordination_requests WHERE id = 'second-review-request'",
    ).get()).toEqual({ state: "completed" }));
    await app.close();
  });

  it("blocks cross-chat coordination until the user explicitly adds the recipient to that Team Chat", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4 },
    });
    const project = store.createProject({ label: "Chat boundaries", hostPath: repoDir });
    const veteransChat = store.createConversation(project.id, { title: "Veterans Memorial" });
    const bigHoleChat = store.createConversation(project.id, { title: "Big Hole" });
    const veterans = store.createAgent(project.id, {
      title: "Vietnam Veterans Memorial", engine: "codex", conversationId: veteransChat.id,
    });
    const bigHole = store.createAgent(project.id, {
      title: "Big Hole", engine: "codex", conversationId: bigHoleChat.id,
    });

    expect((await app.inject({
      method: "POST", url: `/api/agents/${veterans.id}/messages`,
      payload: { text: "Work within this chat", sourceConversationId: veteransChat.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;
    const token = runtime.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const directory = await app.inject({
      method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` },
    });
    expect(directory.statusCode, directory.body).toBe(200);
    expect(directory.json<{ agents: Array<{ agentId: string }> }>().agents.map((agent) => agent.agentId))
      .toEqual([veterans.id]);

    const blocked = await runtime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "cross-chat-blocked",
        requests: [{
          requestId: "cross-chat-request", recipientAgentId: bigHole.id,
          text: "Build unrelated UI", lifetime: { kind: "indefinite" },
        }],
      },
    });
    expect(blocked.success).toBe(false);
    expect(JSON.parse(blocked.text)).toMatchObject({
      error: "every recipient must be a different active agent in this Team Chat",
    });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM coordination_requests WHERE id = 'cross-chat-request'").get())
      .toEqual({ count: 0 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_activations WHERE agent_id = ?").get(bigHole.id))
      .toEqual({ count: 0 });

    store.updateAgentConversationMemberships(bigHole.id, {
      conversationIds: [bigHoleChat.id, veteransChat.id], primaryConversationId: bigHoleChat.id,
    });
    const allowed = await runtime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "shared-chat-allowed",
        requests: [{
          requestId: "shared-chat-request", recipientAgentId: bigHole.id,
          text: "Collaborate in the shared chat", lifetime: { kind: "indefinite" },
        }],
      },
    });
    expect(allowed.success, allowed.text).toBe(true);
    expect(store.sqlite.prepare(`
      SELECT conversation_id FROM coordination_requests WHERE id = 'shared-chat-request'
    `).get()).toEqual({ conversation_id: veteransChat.id });
    await app.close();
  });

  it("derives and resumes a nested join continuation from authoritative run state", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 1_000 },
      executionLeaseScheduling: { leaseMs: 5_000, heartbeatMs: 100 },
    });
    const project = store.createProject({ label: "V3 nested", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const requester = store.createAgent(project.id, {
      title: "Requester", engine: "codex", conversationId: conversation.id,
    });
    const delivery = store.createAgent(project.id, {
      title: "Delivery", engine: "codex", conversationId: conversation.id,
    });
    const specialist = store.createAgent(project.id, {
      title: "Specialist", engine: "codex", conversationId: conversation.id,
    });

    const started = await app.inject({
      method: "POST", url: `/api/agents/${requester.id}/messages`,
      payload: { text: "Coordinate nested delivery", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const outer = await persistent.openedOptions[0]!.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "outer-work",
        requests: [{
          requestId: "delivery-work", recipientAgentId: delivery.id,
          text: "Coordinate a specialist, integrate the result, and complete this request.",
          lifetime: { kind: "indefinite" },
        }],
        join: { id: "outer-join", mode: "all" },
      },
    });
    expect(outer.success, outer.text).toBe(true);
    expect(JSON.parse(outer.text)).toMatchObject({
      joinId: "outer-join", executionDirective: expect.stringContaining("End this turn"),
    });
    persistent.completeTurn(0);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const inner = await persistent.openedOptions[1]!.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "inner-work",
        requests: [{
          requestId: "specialist-work", recipientAgentId: specialist.id,
          text: "Return the bounded specialist result.", lifetime: { kind: "indefinite" },
        }],
        join: { id: "inner-join", mode: "all" },
      },
    });
    expect(inner.success, inner.text).toBe(true);
    expect(store.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'delivery-work'").get())
      .toEqual({ state: "waiting_dependency" });
    expect(store.sqlite.prepare(`
      SELECT continuation_request_ids_json AS continuations FROM coordination_joins WHERE id = 'inner-join'
    `).get()).toEqual({ continuations: '["delivery-work"]' });
    persistent.completeTurn(1);
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'delivery-work' AND kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(3));
    const childCompleted = await persistent.openedOptions[2]!.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { updateId: "specialist-complete", kind: "completed", text: "Specialist result ready." },
    });
    expect(childCompleted.success, childCompleted.text).toBe(true);
    persistent.completeTurn(2);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(4));
    const parentCompleted = await persistent.openedOptions[3]!.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { updateId: "delivery-complete", kind: "completed", text: "Integrated result ready." },
    });
    expect(parentCompleted.success, parentCompleted.text).toBe(true);
    expect(JSON.parse(parentCompleted.text)).toMatchObject({ requestId: "delivery-work", state: "completed" });
    persistent.completeTurn(3);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(5));
    expect(store.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'delivery-work'").get())
      .toEqual({ state: "completed" });
    expect(store.sqlite.prepare("SELECT state FROM coordination_joins WHERE id = 'outer-join'").get())
      .toEqual({ state: "satisfied" });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
    persistent.completeTurn(4);
    await app.close();
  });

  it("accepts an actionable shared V3 request without an invalid audit projection", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    const project = store.createProject({ label: "V3 shared", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, {
      title: "Lead", engine: "codex", conversationId: conversation.id,
    });

    const response = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: {
        text: "Deliver the shared project result.",
        sourceChannel: "main",
        sourceConversationId: conversation.id,
        shareWithOrganization: true,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    const communicationEventId = response.json<{ communicationEventId: string }>().communicationEventId;
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id).some((item) =>
      (item.payload as { communication?: { eventId?: string } }).communication?.eventId === communicationEventId,
    )).toBe(true);
    expect(store.getConversationMessages(conversation.id, "main")).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId, text: "Deliver the shared project result." }),
    ]));
    await app.close();
  });

  it("rebuilds a missing communication projection from SQLite before V3 scheduling starts", async () => {
    const project = store.createProject({ label: "V3 recovery", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, {
      title: "Recipient", engine: "codex", conversationId: conversation.id,
    });
    const event: CommunicationEvent = {
      eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: conversation.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Recover me", createdAt: new Date().toISOString(),
    };
    new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: `dispatch:${event.eventId}:${agent.id}`,
      projectId: project.id,
      sender: event.sender,
      intent: event.intent,
      audience: event.audience,
      payload: { communication: event, dispatch: { text: event.text } },
      activation: {
        agentId: agent.id, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
      now: event.createdAt,
    });
    expect(store.getCommunicationEvent(project.id, event.eventId)).toBeUndefined();

    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    await app.ready();
    expect(store.getCommunicationEvent(project.id, event.eventId)).toEqual(event);
    await app.close();
  });

  it("recovers an attachment-only communication after the SQLite commit crash window", async () => {
    const project = store.createProject({ label: "Attachment recovery", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, {
      title: "Recipient", engine: "codex", conversationId: conversation.id,
    });
    const stagingApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    const uploaded = await stagingApp.inject({
      method: "POST", url: `/api/agents/${agent.id}/attachments`,
      headers: { "content-type": "application/pdf", "x-ponderosa-filename": "brief.pdf" },
      payload: Buffer.from("%PDF-1.7\nrecovery evidence"),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const attachment = uploaded.json<{ id: string; name: string; mediaType: string; size: number }>();
    await stagingApp.close();
    store = new AgentStore(dataDir);

    const event: CommunicationEvent = {
      eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: conversation.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "", createdAt: new Date().toISOString(),
    };
    new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: `dispatch:${event.eventId}:${agent.id}`,
      projectId: project.id,
      sender: event.sender,
      intent: event.intent,
      audience: { agentId: agent.id },
      payload: {
        communication: event,
        dispatch: {
          text: "",
          attachments: [{
            id: attachment.id, name: attachment.name,
            mediaType: attachment.mediaType, size: attachment.size,
          }],
        },
      },
      activation: {
        agentId: agent.id, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
      now: event.createdAt,
    });
    const malformedEventId = randomUUID();
    new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: `dispatch:${malformedEventId}:${agent.id}`,
      projectId: project.id,
      sender: event.sender,
      intent: event.intent,
      audience: { agentId: agent.id },
      payload: {
        communication: { ...event, eventId: malformedEventId },
        dispatch: { text: "", attachments: [{ id: "missing" }] },
      },
      now: event.createdAt,
    });

    const recoveredApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    await recoveredApp.ready();
    expect(store.getCommunicationEvent(project.id, event.eventId)).toMatchObject({
      text: "",
      attachments: [expect.objectContaining({
        id: attachment.id, agentId: agent.id, name: "brief.pdf", state: "associated",
      })],
    });
    expect(store.getCommunicationEvent(project.id, malformedEventId)).toBeUndefined();
    expect((await recoveredApp.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    await recoveredApp.close();
  });

  it("repairs recipient-specific Collaboration copies idempotently at every durable handoff boundary", async () => {
    const project = store.createProject({ label: "Recipient recovery", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Team recovery" });
    const recipients = ["Alpha", "Beta"].map((title) => store.createAgent(project.id, {
      title, engine: "codex", conversationId: conversation.id,
    }));
    const stagingApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    const upload = async (agentId: string, name: string) => {
      const response = await stagingApp.inject({
        method: "POST", url: `/api/agents/${agentId}/attachments`,
        headers: { "content-type": "application/pdf", "x-ponderosa-filename": name },
        payload: Buffer.from(`%PDF-1.7\n${name}`),
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<import("@ponderosa/core").ImageAttachmentDto>();
    };
    const phases = ["sqlite-only", "canonical-only", "room-only"] as const;
    const copies = new Map<string, import("@ponderosa/core").ImageAttachmentDto[]>();
    for (const phase of phases) {
      copies.set(phase, await Promise.all(recipients.map((recipient) => upload(recipient.id, `${phase}-${recipient.title}.pdf`))));
    }
    await stagingApp.close();
    store = new AgentStore(dataDir);

    const coordination = new CoordinationV3Store(store.sqlite);
    const eventIds = new Map<string, string>();
    for (const [index, phase] of phases.entries()) {
      const phaseCopies = copies.get(phase)!;
      const event: CommunicationEvent = {
        eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: conversation.id,
        sender: { kind: "user", userId: "local-operator" }, intent: "collaboration",
        audience: { kind: "agents", agentIds: recipients.map((recipient) => recipient.id) as [string, ...string[]] },
        audienceSelector: "mention", text: "", createdAt: new Date(Date.UTC(2026, 6, 16, 1, index)).toISOString(),
        attachments: [{ ...phaseCopies[0]!, state: "associated" }],
      };
      eventIds.set(phase, event.eventId);
      coordination.recordRuntimeCommunication({
        id: event.eventId, projectId: project.id, sender: event.sender, intent: event.intent, audience: event.audience,
        payload: {
          communication: event,
          dispatch: {
            conversationId: conversation.id,
            text: `#${recipients[0]!.title} #${recipients[1]!.title}`,
            recipients: recipients.map((recipient, recipientIndex) => ({
              agentId: recipient.id,
              attachments: [{
                id: phaseCopies[recipientIndex]!.id,
                name: phaseCopies[recipientIndex]!.name,
                mediaType: phaseCopies[recipientIndex]!.mediaType,
                size: phaseCopies[recipientIndex]!.size,
              }],
            })),
          },
        },
        activations: recipients.map((recipient, recipientIndex) => ({
          agentId: recipient.id, kind: "human_message", priority: 100,
          dispatchPolicy: "steer_or_run", promptClass: "human",
          dedupeKey: `recovery:${event.eventId}:${recipientIndex}`,
        })),
        now: event.createdAt,
      });
      if (phase !== "sqlite-only") store.appendCommunicationEvent(event);
      if (phase === "room-only") {
        store.appendConversationMessage(
          conversation.id,
          { role: "user", text: `#${recipients[0]!.title} #${recipients[1]!.title}`, attachments: event.attachments },
          undefined,
          "collaboration",
          recipients.map((recipient) => ({
            targetAgentId: recipient.id, relayDepth: 0, mentionTrail: [], kind: "tag", audience: "mention",
          })),
          undefined,
          event.eventId,
        );
        // Crash after the first recipient was fully materialized, but before
        // the second recipient's inbox/audit/association handoff.
        const firstRecipient = recipients[0]!;
        const firstCopy = phaseCopies[0]!;
        store.appendCommunicationProjection(project.id, {
          eventId: event.eventId, surface: "agent_inbox", projectionKey: firstRecipient.id, projectedAt: event.createdAt,
        });
        store.appendCommunicationProjection(project.id, {
          eventId: event.eventId, surface: "direct_agent_audit", projectionKey: firstRecipient.id, projectedAt: event.createdAt,
          message: {
            messageId: `${event.eventId}:agent-audit:${firstRecipient.id}`, role: "user",
            renderedText: `#${recipients[0]!.title} #${recipients[1]!.title}`,
            createdAt: event.createdAt, attachments: [{ ...firstCopy, state: "associated" }],
          },
        });
        const metadataPath = path.join(
          dataDir, "projects", project.id, "agents", firstRecipient.id, "attachments", `${firstCopy.id}.json`,
        );
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
        writeFileSync(metadataPath, JSON.stringify({ ...metadata, state: "associated", associatedAt: event.createdAt }));
      }
    }

    let recoveredApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    await recoveredApp.ready();
    for (const phase of phases) {
      const eventId = eventIds.get(phase)!;
      expect(store.getCommunicationEvent(project.id, eventId)?.attachments?.map((item) => item.id))
        .toEqual([copies.get(phase)![0]!.id]);
      expect(store.getConversationMessages(conversation.id, "collaboration").filter((message) =>
        message.communicationEventId === eventId)).toHaveLength(1);
      for (const [recipientIndex, recipient] of recipients.entries()) {
        const expected = copies.get(phase)![recipientIndex]!;
        const audit = store.readProjectedCommunicationMessages(project.id, "direct_agent_audit", recipient.id)
          .find((message) => message.eventId === eventId);
        expect(audit?.attachments?.map((item) => item.id)).toEqual([expected.id]);
        const metadata = JSON.parse(readFileSync(path.join(
          dataDir, "projects", project.id, "agents", recipient.id, "attachments", `${expected.id}.json`,
        ), "utf8")) as { state: string };
        expect(metadata.state).toBe("associated");
        expect((await recoveredApp.inject({ method: "DELETE", url: `/api/agents/${recipient.id}/attachments/${expected.id}` })).statusCode).toBe(409);
      }
    }
    await recoveredApp.close();

    // A second restart must not append duplicate room/audit placements or make
    // an associated recipient copy eligible for staged-file cleanup.
    store = new AgentStore(dataDir);
    recoveredApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    await recoveredApp.ready();
    for (const eventId of eventIds.values()) {
      const projections = store.readCommunicationProjections(project.id).filter((projection) => projection.eventId === eventId);
      expect(projections.filter((projection) => projection.surface === "collaboration_view")).toHaveLength(1);
      for (const recipient of recipients) {
        expect(projections.filter((projection) =>
          projection.surface === "direct_agent_audit" && projection.projectionKey === recipient.id)).toHaveLength(1);
      }
    }
    await recoveredApp.close();
  });

  it("serves every room timeline from canonical projections", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Cutover", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Canonical room" });
    const agent = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });

    const main = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/messages`, payload: { text: "Shared decision" },
    });
    const collaboration = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Review this", recipientAgentIds: [agent.id] },
    });
    expect(main.statusCode).toBe(200);
    expect(collaboration.statusCode, collaboration.body).toBe(200);
    await waitForRun(agent.id);

    const mainDetail = (await app.inject({ method: "GET", url: `/api/conversations/${master.id}` })).json<{
      messages: ConversationMessageDto[];
    }>();
    const collaborationDetail = (await app.inject({ method: "GET", url: `/api/conversations/${master.id}/collaboration` })).json<{
      messages: ConversationMessageDto[];
    }>();
    expect(mainDetail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: main.json().communicationEventId, text: "#broadcast Shared decision" }),
    ]));
    expect(collaborationDetail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: collaboration.json<{ message: { communicationEventId: string } }>().message.communicationEventId, text: "#Reviewer Review this" }),
    ]));
    const readiness = (await app.inject({ method: "GET", url: "/api/ready" })).json();
    expect(readiness, JSON.stringify({ readiness, reconciliation: store.reconcileCommunicationEvents(project.id) }))
      .toMatchObject({ status: "ready", checks: { communicationMigration: { ok: true } } });
    await app.close();
  });

  it("pages chat history with stable cursors and resolves exact historical message links", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Bounded history", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Long room" });
    for (let index = 0; index < 125; index += 1) {
      const createdAt = new Date(1_800_000_000_000 + index).toISOString();
      const eventId = `history-${String(index).padStart(3, "0")}`;
      store.appendCommunicationEvent({
        eventId, schemaVersion: 2, projectId: project.id, conversationId: room.id,
        sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id },
        text: `History ${index}`, createdAt,
      });
      store.appendCommunicationProjection(project.id, {
        eventId, surface: "conversation", projectionKey: room.id, projectedAt: createdAt,
        message: { messageId: eventId, role: "user", renderedText: `History ${index}`, createdAt },
      });
    }

    const bounded = (await app.inject({ method: "GET", url: `/api/conversations/${room.id}` })).json<ConversationDetailDto>();
    expect(bounded.messages).toHaveLength(100);
    expect(bounded.messages[0]?.text).toBe("History 25");
    expect(bounded.history).toMatchObject({ limit: 100, hasMore: true, cursor: expect.any(String) });

    const older = (await app.inject({
      method: "GET",
      url: `/api/conversations/${room.id}?limit=100&cursor=${encodeURIComponent(bounded.history!.cursor!)}`,
    })).json<ConversationDetailDto>();
    expect(older.messages).toHaveLength(25);
    expect(older.messages[0]?.text).toBe("History 0");
    expect(older.messages.at(-1)?.text).toBe("History 24");
    expect(older.history).toEqual({ limit: 100, hasMore: false });

    const focused = (await app.inject({
      method: "GET",
      url: `/api/conversations/${room.id}?focusId=history-010`,
    })).json<ConversationDetailDto>();
    expect(focused.messages.at(-1)).toMatchObject({ communicationEventId: "history-010", text: "History 10" });
    expect(focused.messages).toHaveLength(11);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${room.id}?cursor=not-a-cursor` })).statusCode).toBe(400);
    await app.close();
  });

  it("pages Agent telemetry and Team operations independently and retrieves exact large tool output", async () => {
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 } });
    const project = store.createProject({ label: "Paged telemetry", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Long operations" });
    const agent = store.createAgent(project.id, { title: "Historian", engine: "codex", conversationId: room.id });
    const largeOutput = `${"a".repeat(4_095)}😀END`;
    for (let index = 0; index < 3; index += 1) {
      store.appendEvent(agent.id, { type: "tool_result", id: `tool-${index}`, output: index === 2 ? largeOutput : `output-${index}` });
    }

    const detail = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}?limit=2` })).json<{
      activity: Array<{ seq: number; outputPreview?: { retrievalUrl: string; sha256: string } }>;
      telemetryHistory: { activity: { cursor: string; hasMore: boolean } };
    }>();
    expect(detail.activity).toHaveLength(2);
    expect(detail.telemetryHistory.activity).toMatchObject({ hasMore: true, cursor: expect.any(String) });
    const large = detail.activity.at(-1)!;
    expect(large.outputPreview).toMatchObject({ retrievalUrl: expect.any(String), sha256: createHash("sha256").update(largeOutput).digest("hex") });
    const firstOutput = (await app.inject({
      method: "GET", url: `${large.outputPreview!.retrievalUrl}?maxBytes=4096`,
    })).json<{ output: string; pageUtf8Bytes: number; endUtf8Byte: number; totalUtf8Bytes: number; nextCursor: string }>();
    expect(firstOutput).toMatchObject({ output: "a".repeat(4_095), pageUtf8Bytes: 4_095, endUtf8Byte: 4_095 });
    expect(firstOutput.totalUtf8Bytes).toBe(Buffer.byteLength(largeOutput));
    expect(firstOutput.nextCursor).toEqual(expect.any(String));
    const secondOutputResponse = await app.inject({
      method: "GET",
      url: `${large.outputPreview!.retrievalUrl}?maxBytes=4096&cursor=${encodeURIComponent(firstOutput.nextCursor)}`,
    });
    expect(secondOutputResponse.statusCode, secondOutputResponse.body).toBe(200);
    const secondOutput = secondOutputResponse.json<{ output: string; nextCursor?: string }>();
    expect(firstOutput.output + secondOutput.output).toBe(largeOutput);
    expect(secondOutput.nextCursor).toBeUndefined();
    expect((await app.inject({
      method: "GET", url: `${large.outputPreview!.retrievalUrl}?cursor=${encodeURIComponent(`${firstOutput.nextCursor}x`)}`,
    })).statusCode).toBe(400);
    const older = (await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/history/activity?limit=2&cursor=${encodeURIComponent(detail.telemetryHistory.activity.cursor)}`,
    })).json<{ items: Array<{ id: string; event: { id: string } }>; history: { hasMore: boolean } }>();
    expect(older.items.map((item) => item.event.id)).toEqual(["tool-0"]);
    expect(older.history.hasMore).toBe(false);
    const focused = (await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/history/activity?limit=2&focusId=${encodeURIComponent(older.items[0]!.id)}`,
    })).json<{ items: Array<{ id: string; event: { id: string } }>; history: { hasMore: boolean } }>();
    expect(focused.items).toEqual([expect.objectContaining({ event: expect.objectContaining({ id: "tool-0" }) })]);
    expect((await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/history/activity?focusId=${encodeURIComponent(`${agent.id}:runOutput:1`)}`,
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/history/runs?cursor=${encodeURIComponent(detail.telemetryHistory.activity.cursor)}`,
    })).statusCode).toBe(400);

    const coordination = new CoordinationV3Store(store.sqlite);
    for (let index = 0; index < 3; index += 1) {
      coordination.recordRuntimeCommunication({
        id: `team-operation-${index}`, projectId: project.id, sender: { kind: "user" }, intent: "user_dm",
        scopeKey: `conversation:${room.id}`,
        audience: { kind: "agent", id: agent.id }, payload: { text: `Work ${index}` },
        now: `2026-07-18T00:00:0${index}.000Z`,
        activation: { agentId: agent.id, kind: "human_message", priority: 100, dispatchPolicy: "next_run", promptClass: "human" },
      });
    }
    const team = (await app.inject({ method: "GET", url: `/api/conversations/${room.id}/collaboration?limit=2` })).json<{
      operations: Array<{ id: string }>;
      operationHistory: { cursor: string; hasMore: boolean };
    }>();
    expect(team.operations).toHaveLength(2);
    expect(team.operationHistory).toMatchObject({ hasMore: true, cursor: expect.any(String) });
    const earlierTeam = (await app.inject({
      method: "GET",
      url: `/api/conversations/${room.id}/collaboration?limit=2&operationCursor=${encodeURIComponent(team.operationHistory.cursor)}`,
    })).json<{ operations: Array<{ id: string }>; operationHistory: { hasMore: boolean } }>();
    expect(earlierTeam.operations).toHaveLength(1);
    expect(earlierTeam.operationHistory.hasMore).toBe(false);
    expect(new Set([...team.operations, ...earlierTeam.operations].map((item) => item.id)).size).toBe(3);
    await app.close();
  });

  it("lets eligible room agents retrieve broadcast documents without seeding full content", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Broadcast documents", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Shared room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reader = store.createAgent(project.id, { title: "Reader", engine: "codex", conversationId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Prepare shared guidance" } });
    await waitForSeedCount(1);
    const authorToken = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const full = `# Organization Runbook\n\n${"FULL-SECRET-BODY ".repeat(500)}`;
    const sent = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${authorToken}` },
      payload: { intent: "broadcast", text: "The organization runbook is ready.", document: { title: "Organization Runbook", content: full } },
    });
    expect(sent.statusCode).toBe(200);
    const event = store.getCommunicationEvent(project.id, sent.json<{ eventId: string }>().eventId)!;

    const turn = await app.inject({
      method: "POST", url: `/api/agents/${reader.id}/messages`,
      payload: { text: "Use the shared guidance", sourceChannel: "main", sourceConversationId: master.id, shareWithOrganization: true },
    });
    expect(turn.statusCode).toBe(202);
    await waitForSeedCount(2);
    const seeded = adapter.seeds[1]!.prompt;
    expect(seeded).toContain("The organization runbook is ready.");
    expect(seeded).toContain(`document: Organization Runbook; id: ${event.document!.id}`);
    expect(seeded).not.toContain("FULL-SECRET-BODY");

    const readerToken = adapter.seeds[1]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const retrieved = await app.inject({ method: "GET", url: `/api/agent-documents/${event.document!.id}`, headers: { authorization: `Bearer ${readerToken}` } });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toMatchObject({ title: "Organization Runbook", content: full });
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reader.id)]);
    await app.close();
  });

  it("expires an agent messaging capability when its run ends", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, {
      title: "Agent",
      engine: "codex",
      conversationId: master.id,
    });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Finish." } });
    await waitForRun(agent.id);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { intent: "direct_to_user", text: "Too late." },
    });
    expect(response.statusCode).toBe(401);
    expect(store.getConversationMessages(master.id)).toEqual([
      expect.objectContaining({ text: "#Agent Finish.", communicationEventId: expect.any(String) }),
    ]);
    expect(store.getConversationMessages(master.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Too late." })]),
    );
    await app.close();
  });

  it("does not let forwarded or Host headers redirect capability callbacks", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      headers: { host: "pine.example.test", "x-forwarded-proto": "https" },
      payload: { text: "Use the routed endpoint." },
    });
    await waitForSeedCount(1);
    expect(adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_URL).toBe("http://127.0.0.1:8787/api/agent-messages");
    await cancelAndWait(app, agent.id);
    await app.close();
  });

  it("starts queued tags after a normal tool-boundary turn completes", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Safe boundary" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    adapter.mode = "boundary";
    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Work through a tool call." } });
    await waitForSeedCount(1);

    await Promise.all([
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`, payload: { text: "result one", recipientAgentIds: [parent.id] } }),
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`, payload: { text: "result two", recipientAgentIds: [parent.id] } }),
    ]);
    await waitForRun(parent.id, 2);
    const prompt = adapter.continues.find((turn) => turn.agentId === parent.id)?.prompt ?? "";
    expect(prompt).toContain("Additional coalesced Activations for this scheduler-owned Run:");
    expect(prompt.indexOf("#Parent result one")).toBeLessThan(prompt.indexOf("#Parent result two"));
    await app.close();
  });

  it("wakes a managed requester exactly once through its impossible Join when the child crashes", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Managed failure", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Failure supervision" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    adapter.failuresRemaining = 1;
    const created = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Fragile worker", engine: "codex", conversationId: master.id,
        managerAgentId: manager.id, initialMessage: "Try the risky work.",
      },
    });
    expect(created.statusCode).toBe(200);
    const child = created.json<AgentDto>();
    await waitForSeedCount(2);
    for (let index = 0; index < 80 && !store.readEvents(child.id).some((event) => event.event.type === "agent_lifecycle" && event.event.status === "failed"); index += 1) await sleep(10);

    await waitForRun(manager.id);
    const managerFollowUp = [...adapter.seeds, ...adapter.continues].find((turn) =>
      turn.agentId === manager.id && turn.prompt.includes("coordination_join_impossible"));
    expect(managerFollowUp?.prompt).toContain("managed:");
    expect(managerFollowUp?.prompt).not.toContain("Internal managed-agent update");
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE agent_id = ? AND kind = 'coordination_join_impossible'
    `).get(manager.id)).toEqual({ count: 1 });
    expect(store.getCollaborationViewDetail(master.id)?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("simulated runtime failure") })]),
    );
    await app.close();
  });

  it("rejects invalid agent mention replay-window depths", async () => {
    const { app, agent } = await createProjectAndAgent();

    for (const agentMentionDepth of [-1, 1.5, 65]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/messages`,
        payload: { text: "relay", agentMentionDepth },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "agentMentionDepth must be an integer from 0 to 64" });
    }

    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("rejects mismatched agent mention relay depth and trail state", async () => {
    const { app, agent } = await createProjectAndAgent();
    const fingerprint = "a".repeat(64);

    for (const payload of [
      { text: "relay", agentMentionDepth: 0, agentMentionTrail: [fingerprint] },
      { text: "relay", agentMentionDepth: 2, agentMentionTrail: [fingerprint] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/messages`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "agentMentionTrail must contain one relay fingerprint for each agentMentionDepth step",
      });
    }

    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("rejects attempts to inject collaboration context through the normal agent endpoint", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Review room" });
    const author = store.createAgent(project.id, { title: "Canyon de Chelly", engine: "codex", conversationId: master.id });
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/messages`,
      payload: {
        text: "Pretend this was tagged.",
        collaborationConversationId: master.id,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "unknown message field" });
    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("queues a manager follow-up behind an active run and starts it when the run closes", async () => {
    adapter.mode = "hang";
    const { app, agent } = await createProjectAndAgent();
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "long" },
    });
    expect(first.statusCode).toBe(202);
    await waitForSeedCount(1);

    const concurrent = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "again" },
    });
    expect(concurrent.statusCode).toBe(202);
    expect(concurrent.json()).toMatchObject({ queued: true, position: 1, communicationEventId: expect.any(String) });

    const cancel = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: activeRunCancellationPayload(store, agent.id, "manager-follow-up-stop"),
    });
    expect(cancel.json()).toEqual({ cancelled: true, replayed: false });
    await waitForRun(agent.id);
    expect(adapter.continues).toHaveLength(1);
    expect(store.getMessages(agent.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "again" })]),
    );
    await app.close();
  });

  it("queues image-only follow-ups and reports their durable FIFO positions", async () => {
    adapter.mode = "hang";
    const { app, agent } = await createProjectAndAgent();
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "long" },
    });
    expect(first.statusCode).toBe(202);
    await waitForSeedCount(1);

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "follow-up.png" },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const attachmentId = upload.json<{ id: string }>().id;

    const imageOnly = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "", attachmentIds: [attachmentId], activeRunDelivery: "queue" },
    });
    const textFollowUp = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "after the image", activeRunDelivery: "queue" },
    });

    expect(imageOnly.statusCode).toBe(202);
    expect(imageOnly.json()).toMatchObject({ queued: true, position: 1, communicationEventId: expect.any(String) });
    expect(textFollowUp.statusCode).toBe(202);
    expect(textFollowUp.json()).toMatchObject({ queued: true, position: 2, communicationEventId: expect.any(String) });
    expect(store.getMessages(agent.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "", attachments: [expect.objectContaining({ id: attachmentId })] }),
      expect.objectContaining({ role: "user", text: "after the image" }),
    ]));

    await app.close();
  });

  it("rejects file-browser path escapes", async () => {
    const { app, project } = await createProjectAndAgent();
    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=../outside`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects symlink escapes from the file-browser API", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "pond-server-outside-"));
    writeFileSync(path.join(outsideDir, "secret.txt"), "nope\n", "utf8");
    symlinkSync(outsideDir, path.join(repoDir, "outside-link"));
    const { app, project } = await createProjectAndAgent();

    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=outside-link/secret.txt`,
    });

    expect(res.statusCode).toBe(400);
    rmSync(outsideDir, { recursive: true, force: true });
    await app.close();
  });

  it("parses staged, unstaged, untracked, and renamed Git status records", () => {
    expect(parseGitStatus("M  staged.ts\0 M unstaged.ts\0?? new.ts\0R  renamed.ts\0old.ts\0")).toEqual([
      expect.objectContaining({ path: "new.ts", kind: "create", untracked: true }),
      expect.objectContaining({ path: "renamed.ts", previousPath: "old.ts", kind: "rename", staged: true }),
      expect.objectContaining({ path: "staged.ts", kind: "edit", staged: true, unstaged: false }),
      expect.objectContaining({ path: "unstaged.ts", kind: "edit", staged: false, unstaged: true }),
    ]);
  });

  it("serves Git-backed workspace review without exposing credential files", async () => {
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
    writeFileSync(path.join(repoDir, "README.md"), "# changed\n", "utf8");
    writeFileSync(path.join(repoDir, "new.ts"), "export const ready = true;\n", "utf8");
    writeFileSync(path.join(repoDir, ".env"), "TOKEN=hidden\n", "utf8");
    const { app, project } = await createProjectAndAgent();

    const status = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      projectId: project.id,
      isGitRepository: true,
      changes: expect.arrayContaining([
        expect.objectContaining({ path: "README.md", kind: "edit", unstaged: true }),
        expect.objectContaining({ path: "new.ts", kind: "create", untracked: true }),
      ]),
    });
    expect(status.json<{ changes: Array<{ path: string }> }>().changes.some((change) => change.path === ".env")).toBe(false);

    const review = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace/file?path=README.md` });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ projectId: project.id, path: "README.md", exists: true, content: "# changed\n" });
    expect(review.json<{ diff: string }>().diff).toContain("+# changed");

    const hidden = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace/file?path=.env` });
    expect(hidden.statusCode).toBe(400);
    await app.close();
  });

  it("rejects cross-origin browser mutations while allowing same-origin requests", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://evil.test" },
      payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://ponderosa.test" },
      payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    await app.close();
  });

  it("caps file-browser reads and preserves binary data as base64", async () => {
    writeFileSync(path.join(repoDir, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    writeFileSync(path.join(repoDir, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    const { app, project } = await createProjectAndAgent();
    const large = await app.inject({ method: "GET", url: `/api/files?projectId=${project.id}&path=large.bin` });
    const binary = await app.inject({ method: "GET", url: `/api/files?projectId=${project.id}&path=binary.bin` });
    expect(large.statusCode).toBe(400);
    expect(large.json()).toEqual({ error: "file exceeds 2 MiB browser limit" });
    expect(binary.json()).toEqual(expect.objectContaining({ encoding: "base64", content: "//79" }));
    await app.close();
  });

  it("reports engine auth status without requiring real CLI auth", async () => {
    const failing = new MockAdapter();
    failing.id = "broken";
    failing.displayName = "Broken";
    const app = createServer({
      dataDir,
      store,
      logger: false,
      engines: [
        { adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) },
        {
          adapter: failing,
          authStatus: async () => {
            throw new Error("not logged in");
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/engines" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "codex", authenticated: true, authDetail: "test" }),
      expect.objectContaining({ id: "broken", authenticated: false, authDetail: "not logged in" }),
    ]);
    await app.close();
  });

  it("rediscovers inherited engine capabilities and reports newly available skills", async () => {
    let discoveries = 0;
    Object.assign(adapter, { capabilities: async () => {
      discoveries += 1;
      const skill = { id: `skill:review-${discoveries}`, kind: "skill" as const, label: `review-${discoveries}`, description: "Review changes", status: "available" as const, insertText: `$review-${discoveries} ` };
      return { steering: true, persistentSessions: true, commands: [], mcpServers: [], composerCapabilities: [skill] };
    } });
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Capabilities", hostPath: repoDir });

    const first = await app.inject({ method: "GET", url: `/api/projects/${project.id}/engine-capabilities` });
    const second = await app.inject({ method: "GET", url: `/api/projects/${project.id}/engine-capabilities` });

    expect(first.statusCode).toBe(200);
    expect(first.json<ProjectEngineCapabilitiesDto[]>()[0]?.composerCapabilities[0]?.label).toBe("review-1");
    expect(second.json<ProjectEngineCapabilitiesDto[]>()[0]?.composerCapabilities[0]?.label).toBe("review-2");
    expect(discoveries).toBe(2);
    await app.close();
  });

  it("keeps switch-engine stubbed while global and legacy agent search use projected chat messages", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const conversationId = project.lastConversationId!;
    const message = appendBroadcast(store, project.id, conversationId, "Find this cross-project history needle");

    const switchEngine = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/switch-engine`,
      payload: { engine: "claude" },
    });
    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=history&limit=5",
    });
    const legacyAgentSearch = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/search?q=history`,
    });

    expect(switchEngine.statusCode).toBe(501);
    expect(search.statusCode).toBe(200);
    const searchBody = search.json<{ query: string; results: Array<{ project: { id: string }; chat: { kind: string; id: string }; messageId: string; snippet: string }>; scannedMessages: number; truncated: boolean }>();
    expect(searchBody.query).toBe("history");
    expect(searchBody.results).toHaveLength(1);
    expect(searchBody.results[0]).toMatchObject({
      project: { id: project.id },
      chat: { kind: "conversation", id: conversationId },
      messageId: message!.id,
    });
    expect(searchBody.results[0]!.snippet).toContain("history");
    expect(searchBody.scannedMessages).toBeGreaterThanOrEqual(1);
    expect(searchBody.truncated).toBe(false);
    expect(legacyAgentSearch.statusCode).toBe(200);
    expect(legacyAgentSearch.json()).toMatchObject({ query: "history", results: [] });

    const tooLong = await app.inject({ method: "GET", url: `/api/search?q=${"x".repeat(201)}` });
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it("deletes an agent: removes projections + on-disk log, cancels active run", async () => {
    const { app, project, agent } = await createProjectAndAgent();

    // Give the agent some history so there's a log + projections to remove.
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "do work" },
    });
    await waitForRun(agent.id);
    expect(store.readEvents(agent.id).length).toBeGreaterThan(0);

    const del = await deleteAgentsWithServerPreview(app, project.id, [agent.id]);
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>().deleted).toBe(true);

    // Gone from the projection list and by id.
    const list = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agents` });
    expect(list.json<unknown[]>()).toHaveLength(0);
    const detail = await app.inject({ method: "GET", url: `/api/agents/${agent.id}` });
    expect(detail.statusCode).toBe(404);

    // Deleting again is a 404.
    const again = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agent-deletions/preview`,
      payload: { rootAgentIds: [agent.id] },
    });
    expect(again.statusCode).toBe(404);

    // On-disk agent directory is gone (rebuild won't resurrect it).
    store.rebuildProjections();
    const afterRebuild = await app.inject({ method: "GET", url: `/api/agents/${agent.id}` });
    expect(afterRebuild.statusCode).toBe(404);
    await app.close();
  });

  it("continues a conversation after a historical message author is deleted", async () => {
    const project = store.createProject({ label: "Deleted author history", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Durable history" });
    const author = store.createAgent(project.id, { title: "Former author", engine: "codex", conversationId: room.id });
    const recipient = store.createAgent(project.id, { title: "Current recipient", engine: "codex", conversationId: room.id });
    const event: CommunicationEvent = {
      eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "historical-execution" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Historical answer",
      createdAt: "2026-07-15T02:19:10.342Z",
    };
    store.appendCommunicationEvent(event);
    store.appendConversationMessage(room.id, { role: "assistant", text: event.text }, author.id, "main", undefined, undefined, event.eventId);
    expect(store.deleteAgent(author.id)).toBe(true);

    const app = createServer({ dataDir, store, engines, logger: false });
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${room.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ messages: Array<{ text: string; authorAgentId?: string; fileActivity?: unknown }> }>().messages)
      .toEqual([expect.objectContaining({ text: event.text, authorAgentId: author.id })]);
    expect(detail.json<{ messages: Array<{ fileActivity?: unknown }> }>().messages[0]).not.toHaveProperty("fileActivity");

    const sent = await app.inject({
      method: "POST", url: `/api/agents/${recipient.id}/messages`, payload: { text: "Continue from that answer." },
    });
    expect(sent.statusCode).toBe(202);
    await waitForRun(recipient.id);
    await app.close();
  });

  it("serves the web build with SPA fallback and scoped static paths", async () => {
    const webDist = mkdtempSync(path.join(tmpdir(), "pond-server-web-"));
    mkdirSync(path.join(webDist, "assets"));
    mkdirSync(path.join(webDist, "static", "js"), { recursive: true });
    writeFileSync(path.join(webDist, "index.html"), "<main>app</main>", "utf8");
    writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app');\n", "utf8");
    writeFileSync(path.join(webDist, "static", "js", "app.123.js"), "console.log('fingerprinted');\n", "utf8");
    writeFileSync(path.join(webDist, "sw.js"), "self.addEventListener('install', () => {});\n", "utf8");
    writeFileSync(path.join(webDist, "register-sw.js"), "console.log('register');\n", "utf8");
    const app = createServer({ dataDir, store, engines, webDist, logger: false });

    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    const fingerprinted = await app.inject({ method: "GET", url: "/static/js/app.123.js" });
    const serviceWorker = await app.inject({ method: "GET", url: "/sw.js" });
    const registerSw = await app.inject({ method: "GET", url: "/register-sw.js" });
    const fallback = await app.inject({ method: "GET", url: "/agents/abc" });
    const apiMiss = await app.inject({ method: "GET", url: "/api/not-real" });
    const escape = await app.inject({ method: "GET", url: "/%5c..%5cpackage.json" });

    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("<main>app</main>");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["x-frame-options"]).toBe("DENY");
    expect(index.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(index.headers["content-security-policy"]).toContain("img-src 'self' data: blob:");
    expect(asset.body).toContain("console.log");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(fallback.headers["cache-control"]).toBe("no-cache");
    expect(serviceWorker.headers["cache-control"]).toBe("no-cache");
    expect(registerSw.headers["cache-control"]).toBe("no-cache");
    expect(fingerprinted.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["cache-control"]).toBe("public, max-age=3600");
    expect(fallback.body).toContain("<main>app</main>");
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.body).not.toContain("<main>app</main>");
    expect(escape.statusCode).toBe(404);

    await app.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  it("does not expose legacy delegation registration or output routes", async () => {
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Delegation room" });
    const agent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const parent = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "delegate" } });
    const parentRunId = parent.json<{ runId: string }>().runId;

    expect((await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/assignments`,
      payload: { parentRunId, displayLabel: "Spoof", delegationPrompt: "bad", runtime: "codex", idempotencyKey: "legacy" },
    })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/internal/assignments/missing/launch", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/internal/assignments/missing/output", payload: { text: "forged" } })).statusCode).toBe(404);

    await cancelAndWait(app, agent.id);
    await app.close();
  });

  it("validates, scopes, persists, serves, and prevents deletion of sent image attachments", async () => {
    const { app, agent } = await createProjectAndAgent();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const rejected = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/attachments`, headers: { "content-type": "image/png" }, payload: Buffer.from("<svg><script/></svg>") });
    expect(rejected.statusCode).toBe(415);
    const uploaded = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/attachments`, headers: { "content-type": "image/png", "x-ponderosa-filename": "../../screen.png" }, payload: png });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json<{ id: string; name: string; url: string }>();
    expect(attachment.name).toBe("screen.png");
    expect(attachment.url).not.toContain(dataDir);
    const send = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "", attachmentIds: [attachment.id] } });
    expect(send.statusCode).toBe(202);
    const communicationEventId = send.json<{ communicationEventId: string }>().communicationEventId;
    expect(store.getCommunicationEvent(agent.projectId, communicationEventId)).toMatchObject({
      text: "",
      attachments: [expect.objectContaining({ id: attachment.id, agentId: agent.id, name: "screen.png" })],
    });
    await waitForRun(agent.id);
    expect(store.getMessages(agent.id)[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, agentId: agent.id });
    store.rebuildProjections();
    expect(store.getMessages(agent.id)[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, agentId: agent.id });
    expect(adapter.seeds[0]?.prompt).toContain("Attached images");
    expect(adapter.seeds[0]?.prompt).not.toContain("base64");
    expect((await app.inject({ method: "GET", url: attachment.url })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "DELETE", url: attachment.url })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/agents/not-${agent.id}/messages`, payload: { text: "x", attachmentIds: [attachment.id] } })).statusCode).toBe(404);
    await app.close();
  });

  it("serves general assets only as bounded private downloads with non-enumerating ownership failures", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const second = store.createAgent(project.id, { title: "Other", engine: "codex" });
    const uploaded = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/attachments`,
      headers: { "content-type": "application/octet-stream", "x-ponderosa-media-type": "application/pdf", "x-ponderosa-filename": "résumé.pdf" },
      payload: Buffer.from("%PDF-1.7\n<script>download only</script>"),
    });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json<{ id: string; url: string; previewUrl?: string; downloadUrl: string }>();
    expect(asset.previewUrl).toBeUndefined();
    expect(asset.url).toBe(asset.downloadUrl);
    const download = await app.inject({ method: "GET", url: asset.downloadUrl });
    expect(download.statusCode).toBe(200);
    expect(download.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": "none",
    });
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect((await app.inject({ method: "GET", url: asset.downloadUrl, headers: { range: "bytes=0-2" } })).statusCode).toBe(416);
    const foreignUrl = `/api/agents/${second.id}/assets/${asset.id}/download`;
    expect((await app.inject({ method: "GET", url: foreignUrl })).json()).toEqual({ error: "asset not found" });
    expect((await app.inject({ method: "GET", url: `/api/agents/${second.id}/assets/${randomUUID()}/download` })).json()).toEqual({ error: "asset not found" });
    expect((await deleteAgentsWithServerPreview(app, project.id, [agent.id])).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: asset.downloadUrl })).statusCode).toBe(404);
    expect(existsSync(path.join(dataDir, "projects", project.id, "agents", agent.id))).toBe(false);
    await app.close();
  });

  it("streams live SSE and replays from last seen seq without duplicates", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const base = `http://127.0.0.1:${address.port}`;

    const liveAbort = new AbortController();
    const live = await fetch(`${base}/api/agents/${agent.id}/stream`, { signal: liveAbort.signal });
    const reader = live.body!.getReader();
    await fetch(`${base}/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stream" }),
    });

    let chunk = "";
    for (let i = 0; i < 30 && !chunk.includes('"type":"agent_output"'); i += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    liveAbort.abort();
    expect(chunk).toContain("id: 2");
    expect(chunk).toContain('"type":"session"');
    expect(chunk).toContain('"type":"agent_output"');
    expect(chunk).toContain('"executionId":');
    expect(chunk).toContain('"text":"done"');
    expect(chunk).not.toContain('"replayed":true');
    await waitForRun(agent.id);

    const replayAbort = new AbortController();
    const replay = await fetch(`${base}/api/agents/${agent.id}/stream?lastEventId=1`, {
      signal: replayAbort.signal,
    });
    const replayReader = replay.body!.getReader();
    const replayRead = await replayReader.read();
    replayAbort.abort();
    const replayChunk = new TextDecoder().decode(replayRead.value);
    expect(replayChunk).toContain("id: 2");
    expect(replayChunk).not.toMatch(/(?:^|\n)id: 1\n/);
    expect(replayChunk).toContain('"replayed":true');

    expect(project.id).toBeTruthy();
    await app.close();
  }, 10000);

  it("resets an ahead workspace cursor and replays from the canonical beginning", async () => {
    const { app } = await createProjectAndAgent();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/stream?lastEventId=999999`, { signal: abort.signal });
    const reader = response.body!.getReader();
    let chunk = "";
    for (let index = 0; index < 10 && !chunk.includes("id: 1"); index += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    abort.abort();
    expect(chunk).toContain("event: workspace_status");
    expect(chunk).toContain('"reset":true');
    expect(chunk).toContain('"instanceId":');
    expect(chunk).toContain("id: 1");
    await app.close();
  }, 10000);

  it("resets an ahead Agent cursor and announces the durable high-water mark", async () => {
    const { app, agent } = await createProjectAndAgent();
    store.appendEvent(agent.id, { type: "error", message: "durable" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/${agent.id}/stream?lastEventId=999999`, { signal: abort.signal });
    const reader = response.body!.getReader();
    let chunk = "";
    for (let index = 0; index < 10 && !chunk.includes("id: 1"); index += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    abort.abort();
    expect(chunk).toContain("event: agent_status");
    expect(chunk).toContain(`\"agentId\":\"${agent.id}\"`);
    expect(chunk).toContain('"cursor":1');
    expect(chunk).toContain('"reset":true');
    expect(chunk).toContain("id: 1");
    expect(chunk).toContain('"replayed":true');
    await app.close();
  }, 10000);

  it("validates individual reply targets and sends compact quoted context", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Original question" } });
    await waitForRun(agent.id);
    const original = store.getMessages(agent.id)[0]!;
    const other = store.createAgent(project.id, { title: "Other", engine: "codex" });
    const rejected = await app.inject({ method: "POST", url: `/api/agents/${other.id}/messages`, payload: { text: "Cross-boundary", replyToMessageId: original.id } });
    expect(rejected.statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Specific answer", replyToMessageId: original.id } });
    expect(accepted.statusCode).toBe(202);
    await waitForRun(agent.id, 2);
    const replyTurn = [...adapter.seeds, ...adapter.continues].find((turn) => turn.prompt.includes("Specific answer"));
    expect(replyTurn?.prompt).toContain("Replying specifically to this earlier message");
    expect(replyTurn?.prompt).toContain("Original question");
    expect(store.getMessages(agent.id).find((message) => message.text === "Specific answer")?.replyTo?.messageId).toBe(original.id);
    await app.close();
  });

  it("delivers Reply Directly once and replays a stable receipt", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const other = store.createAgent(project.id, { title: "Other", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Result" }, author.id)!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "direct.png" },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const attachmentId = upload.json<{ id: string }>().id;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, attachmentIds: [attachmentId], idempotencyKey: "reply-1" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ replayed: false, targetAuthorAgentId: author.id });
    await waitForRun(author.id);
    expect(adapter.seeds.find((turn) => turn.agentId === author.id)?.prompt)
      .toContain("Replying specifically to this earlier message:\n> Result");

    const replayed = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, attachmentIds: [attachmentId], idempotencyKey: "reply-1" },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ replayed: true, messageId: accepted.json<{ messageId: string }>().messageId });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Follow up")).toHaveLength(1);
    expect(store.getConversationMessages(master.id).find((message) => message.text === "#Author Follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    const directAudit = store.readCommunicationProjections(project.id).find((projection) =>
      projection.surface === "direct_agent_audit" && projection.projectionKey === author.id &&
      projection.message?.renderedText === "Follow up");
    expect(directAudit?.message?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Changed payload", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "reply-1" },
    });
    expect(conflict.statusCode).toBe(409);

    const concurrentPayload = { text: "Concurrent follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "reply-concurrent" };
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload: concurrentPayload }),
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload: concurrentPayload }),
    ]);
    expect(concurrent.some((response) => response.statusCode === 200)).toBe(true);
    const concurrentReplay = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload: concurrentPayload });
    expect(concurrentReplay.json()).toMatchObject({ replayed: true });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Concurrent follow up")).toHaveLength(1);
    await waitForRun(author.id, 2);

    const spoofed = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Wrong target", replyToMessageId: report.id, targetAuthorAgentId: other.id, idempotencyKey: "reply-2" },
    });
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json()).toMatchObject({ error: expect.stringMatching(/must be the author/) });
    await app.close();
  });

  it("creates missing V3 runtime state from an authored direct-reply projection without duplicates", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Recovery room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Result" }, author.id)!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "recovered.png" },
      payload: png,
    });
    const attachmentId = upload.json<{ id: string }>().id;
    const receiptKey = `direct-reply:${master.id}:crash-window`;
    const canonical = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { text: "#Author Recovered follow up", replyToMessageId: report.id, directReplyToAuthorAgentId: author.id, attachments: [upload.json()] },
      undefined,
      "main",
      [{ targetAgentId: author.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
      receiptKey,
    )!;
    const agentCount = store.listAgents(project.id).length;
    const payload = { text: "Recovered follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, attachmentIds: [attachmentId], idempotencyKey: "crash-window" };
    const replay = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ messageId: canonical.id, replayed: false });
    const secondReplay = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    expect(secondReplay.json()).toMatchObject({ messageId: canonical.id, replayed: true });
    await waitForRun(author.id);
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Recovered follow up")).toHaveLength(1);
    const audit = store.readCommunicationProjections(project.id).find((projection) =>
      projection.surface === "direct_agent_audit" && projection.projectionKey === author.id &&
      projection.message?.renderedText === "Recovered follow up");
    expect(audit?.message?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    expect(store.listAgents(project.id)).toHaveLength(agentCount);
    await app.close();
  });

  it("creates V3 activation state when an authored direct reply has no runtime record", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Incomplete recovery room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Result" }, author.id)!;
    appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { text: "#Author Incomplete follow up", replyToMessageId: report.id, directReplyToAuthorAgentId: author.id },
      undefined,
      "main",
      undefined,
      `direct-reply:${master.id}:missing-intent`,
      [author.id],
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Incomplete follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "missing-intent" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: false, queued: true });
    await waitForRun(author.id);
    expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "direct_agent_audit", projectionKey: author.id }),
    ]));
    await app.close();
  });

  it("queues one direct reply for a busy author and deduplicates retries", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Busy room" });
    const author = store.createAgent(project.id, { title: "Busy author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Working" }, author.id)!;
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Current work" } });
    await waitForSeedCount(1);

    const payload = {
      text: "Queued follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id,
      idempotencyKey: "busy-reply", activeRunDelivery: "queue" as const,
    };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    const retry = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    expect(first.json()).toMatchObject({ replayed: false, queued: true });
    expect(retry.json()).toMatchObject({ replayed: true, queued: true, messageId: first.json<{ messageId: string }>().messageId });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Busy-author Queued follow up")).toHaveLength(1);

    const queued = (await app.inject({ method: "GET", url: `/api/agents/${author.id}/queued-messages` }))
      .json<Array<{ deliveryId: string; text: string }>>();
    expect(queued).toEqual([expect.objectContaining({ text: "Queued follow up" })]);
    const editedText = "Edited queued follow up";
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/agents/${author.id}/queued-messages/${queued[0]!.deliveryId}`,
      payload: { text: editedText, idempotencyKey: "edit-busy-reply" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ edited: true, replayed: false, status: "edited" });
    expect((await app.inject({ method: "GET", url: `/api/agents/${author.id}/queued-messages` })).json())
      .toEqual([expect.objectContaining({ text: editedText })]);
    const steered = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/queued-messages/${queued[0]!.deliveryId}/steer`,
      payload: { idempotencyKey: "steer-busy-reply" },
    });
    expect(steered.statusCode, steered.body).toBe(200);
    expect(steered.json()).toMatchObject({ steered: true, replayed: false, status: "steered" });

    adapter.mode = "normal";
    await app.inject({
      method: "POST", url: `/api/agents/${author.id}/cancel`,
      payload: activeRunCancellationPayload(store, author.id, "busy-reply-stop"),
    });
    await expect.poll(() => adapter.seeds.length + adapter.continues.length).toBe(2);
    expect([...adapter.seeds, ...adapter.continues]
      .filter((turn) => turn.agentId === author.id && turn.prompt.includes(editedText))).toHaveLength(1);
    await app.close();
  });

  it("revisions a queued long message without exposing superseded content or artifacts", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Sensitive edit room" });
    const author = store.createAgent(project.id, { title: "Sensitive author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Working" }, author.id)!;
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Current work" } });
    await waitForSeedCount(1);

    const supersededMarker = "SUPERSEDED-SECRET-INSTRUCTION";
    const originalText = `${supersededMarker}\n${"s".repeat(100_000)}`;
    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: {
        text: originalText,
        replyToMessageId: report.id,
        targetAuthorAgentId: author.id,
        idempotencyKey: "sensitive-queued-reply",
        activeRunDelivery: "queue",
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const queued = (await app.inject({ method: "GET", url: `/api/agents/${author.id}/queued-messages` }))
      .json<Array<{ deliveryId: string; text: string }>>();
    const before = new CoordinationV3Store(store.sqlite).pendingActivations(project.id)
      .find((activation) => activation.id === queued[0]!.deliveryId)!;
    const beforePayload = before.payload as { communication?: { eventId?: string }; dispatch?: { artifactId?: string } };
    const communicationEventId = beforePayload.communication?.eventId;
    const originalArtifactId = beforePayload.dispatch?.artifactId;
    expect(originalArtifactId).toMatch(/^text-/);
    if (!communicationEventId || !originalArtifactId) throw new Error("expected queued communication and long-text artifact identity");

    const replacement = "Use only this safe replacement";
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/agents/${author.id}/queued-messages/${queued[0]!.deliveryId}`,
      payload: { text: replacement, idempotencyKey: "replace-sensitive-queued-reply" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const editReplays = await Promise.all(Array.from({ length: 2 }, () => app.inject({
      method: "PATCH",
      url: `/api/agents/${author.id}/queued-messages/${queued[0]!.deliveryId}`,
      payload: { text: replacement, idempotencyKey: "replace-sensitive-queued-reply" },
    })));
    expect(editReplays.map((response) => response.json())).toEqual([
      expect.objectContaining({ edited: true, replayed: true }),
      expect.objectContaining({ edited: true, replayed: true }),
    ]);
    const after = new CoordinationV3Store(store.sqlite).pendingActivations(project.id)
      .find((activation) => activation.id === queued[0]!.deliveryId)!;
    const serializedAfter = JSON.stringify(after.payload);
    expect(serializedAfter).toContain(replacement);
    expect(serializedAfter).not.toContain(supersededMarker);
    expect(serializedAfter).not.toContain(originalArtifactId);

    await expect.poll(() => store.readCommunicationRevisions(project.id).length).toBe(1);
    for (const surface of ["conversation", "direct_agent_audit"] as const) {
      const projectionKey = surface === "conversation" ? master.id : author.id;
      const current = store.readProjectedCommunicationMessages(project.id, surface, projectionKey)
        .find((message) => message.eventId === communicationEventId);
      expect(current?.text).toContain(replacement);
      expect(current?.text).not.toContain(supersededMarker);
      expect(current?.document).toBeUndefined();
    }

    expect((await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/queued-messages/${queued[0]!.deliveryId}/steer`,
      payload: { idempotencyKey: "steer-revised-sensitive-reply" },
    })).statusCode).toBe(200);
    adapter.mode = "normal";
    await app.inject({
      method: "POST", url: `/api/agents/${author.id}/cancel`,
      payload: activeRunCancellationPayload(store, author.id, "sensitive-reply-stop"),
    });
    await expect.poll(() => store.getRuns(author.id).length).toBe(2);
    const providerInput = store.getProviderInput(store.getRuns(author.id).at(-1)!.id, true)!;
    expect(providerInput.exactPrompt).toContain(replacement);
    expect(providerInput.exactPrompt).not.toContain(supersededMarker);
    expect(providerInput.exactPrompt).not.toContain(originalArtifactId);
    expect(providerInput.sourceManifest.artifactIds).not.toContain(originalArtifactId);
    await app.close();
  });

  it("recovers a committed queued edit before delivery when projection append is interrupted", async () => {
    const project = store.createProject({ label: "Queued edit recovery", hostPath: repoDir, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Recovery room" });
    const agent = store.createAgent(project.id, { title: "Recovery agent", engine: "codex", conversationId: conversation.id });
    const createdAt = "2026-07-18T12:00:00.000Z";
    const communication = {
      eventId: "queued-edit-recovery-message",
      schemaVersion: 2 as const,
      projectId: project.id,
      conversationId: conversation.id,
      sender: { kind: "user" as const, userId: "local-operator" },
      intent: "user_dm" as const,
      audience: { kind: "user_agent" as const, userId: "local-operator", agentId: agent.id },
      text: "superseded",
      createdAt,
      idempotencyKey: "queued-edit-recovery-message",
    };
    store.appendCommunicationEvent(communication);
    let coordination = new CoordinationV3Store(store.sqlite);
    const intake = coordination.recordRuntimeCommunication({
      id: communication.eventId,
      projectId: project.id,
      sender: communication.sender,
      intent: communication.intent,
      audience: { agentId: agent.id },
      payload: { communication, dispatch: { conversationId: conversation.id, text: communication.text } },
      activation: { agentId: agent.id, kind: "human_message", priority: 100, dispatchPolicy: "next_run" },
      now: createdAt,
    });
    for (const item of coordination.claimOutbox("seed-signal-drain")) {
      coordination.completeOutbox(item.id, "seed-signal-drain");
    }

    const interrupted = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 },
      messageLifecycleFaults: {
        afterQueuedEditSqliteCommit: () => { throw new Error("simulated process loss after SQLite commit"); },
      },
    });
    const edit = await interrupted.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/queued-messages/${intake.activationId}`,
      payload: { text: "safe replacement", idempotencyKey: "recover-edit" },
    });
    expect(edit.statusCode).toBe(500);
    expect(store.readCommunicationRevisions(project.id)).toEqual([]);
    expect(coordination.leaseNextRun({ workerId: "must-not-deliver" })).toBeUndefined();
    await interrupted.close();

    store = new AgentStore(dataDir);
    coordination = new CoordinationV3Store(store.sqlite);
    const recovered = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 5 },
    });
    await recovered.ready();
    await expect.poll(() => store.readCommunicationRevisions(project.id).length).toBe(1);
    expect(store.readCommunicationRevisions(project.id)[0]).toMatchObject({
      targetEventId: communication.eventId,
      text: "safe replacement",
    });
    const lease = coordination.leaseNextRun({ workerId: "after-recovery" });
    expect(JSON.stringify(lease?.activations[0]?.payload)).toContain("safe replacement");
    expect(JSON.stringify(lease?.activations[0]?.payload)).not.toContain("superseded");
    await recovered.close();
  });

  it("uses the same safe-boundary Steer semantics in Project and Agent chat", async () => {
    const persistent = new SteerableMockAdapter();
    adapter = persistent;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
    const { app, project, agent } = await createProjectAndAgent();
    const masterId = store.getProject(project.id)!.lastConversationId!;
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [masterId], primaryConversationId: masterId } });
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Active turn" } })).statusCode).toBe(202);
    await expect.poll(() => persistent.starts.length).toBe(1);

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${masterId}/direct-messages`,
      payload: { text: "Steer from Project chat", recipients: [{ agentId: agent.id }], idempotencyKey: "project-steer", activeRunDelivery: "steer" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ recipients: [{ agentId: agent.id, queued: true, state: "queued" }] });
    await expect.poll(() => persistent.steers.length).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${masterId}/queued-messages` })).json()).toEqual([]);
    await app.close();
  });

  it("appends one immutable correction and dispatches exactly one idempotent follow-up turn", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const masterId = store.getProject(project.id)!.lastConversationId!;
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [masterId], primaryConversationId: masterId } });
    const originalSend = await app.inject({
      method: "POST", url: `/api/conversations/${masterId}/direct-messages`,
      payload: { text: "Original request", recipients: [{ agentId: agent.id }], idempotencyKey: "original-request" },
    });
    const originalMessageId = originalSend.json<{ messageId: string }>().messageId;
    await waitForRun(agent.id);

    const refusedSteer = await app.inject({
      method: "POST",
      url: `/api/conversations/${masterId}/messages/${originalMessageId}/corrections`,
      payload: { text: "Wrong delivery mode", idempotencyKey: "correction-steer", activeRunDelivery: "steer" },
    });
    expect(refusedSteer.statusCode).toBe(400);
    expect(refusedSteer.json()).toEqual({ error: "corrections always queue a new turn" });
    const correctionPayload = { text: "Corrected request", idempotencyKey: "correction-once" };
    const corrected = await app.inject({ method: "POST", url: `/api/conversations/${masterId}/messages/${originalMessageId}/corrections`, payload: correctionPayload });
    const replay = await app.inject({ method: "POST", url: `/api/conversations/${masterId}/messages/${originalMessageId}/corrections`, payload: correctionPayload });
    expect(corrected.json()).toMatchObject({ originalMessageId, replayed: false });
    expect(replay.json()).toMatchObject({ originalMessageId, replayed: true, correctionMessageId: corrected.json<{ correctionMessageId: string }>().correctionMessageId });
    await waitForRun(agent.id, 2);

    const timeline = store.getConversationMessages(masterId);
    expect(timeline.find((message) => message.id === originalMessageId)?.text).toBe("Original request");
    expect(timeline.find((message) => message.id === originalMessageId)?.correctedByMessageId).toBe(corrected.json<{ correctionMessageId: string }>().correctionMessageId);
    expect(timeline.filter((message) => message.correctionOfMessageId === originalMessageId)).toHaveLength(1);
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunication(
      corrected.json<{ correctionMessageId: string }>().correctionMessageId,
    )).toBeTruthy();
    await app.close();
  });

  it("updates mutable agent organization through stable IDs without rewriting delegation provenance", async () => {
    const { app, project, agent: parent } = await createProjectAndAgent();
    const child = store.createAgent(project.id, { title: "Child", engine: "codex" });
    const grandchild = store.createAgent(project.id, { title: "Grandchild", engine: "codex" });

    const demoted = await app.inject({
      method: "PUT", url: `/api/agents/${child.id}/manager`, payload: { managerAgentId: parent.id },
    });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json()).toMatchObject({ id: child.id, managerAgentId: parent.id });
    await app.inject({ method: "PUT", url: `/api/agents/${grandchild.id}/manager`, payload: { managerAgentId: child.id } });
    const cycle = await app.inject({ method: "PUT", url: `/api/agents/${parent.id}/manager`, payload: { managerAgentId: grandchild.id } });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json()).toMatchObject({ error: expect.stringMatching(/cycle/) });

    const promoted = await app.inject({ method: "PUT", url: `/api/agents/${child.id}/manager`, payload: { managerAgentId: null } });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).not.toHaveProperty("managerAgentId");
    expect(store.readAgentOrganizationEvents(project.id)).toHaveLength(3);
    await app.close();
  });
});

describe("V3.3 Decisions, management, and portability", () => {
  it("scopes describe/plan/apply to descendants and requires an approved Decision for deletion", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5, maxConcurrentRuns: 4 } });
    const project = store.createProject({ label: "Management", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Team" });
    const owner = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", conversationId: conversation.id, managerAgentId: owner.id });
    const outsider = store.createAgent(project.id, { title: "Outsider", engine: "codex", conversationId: conversation.id });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${owner.id}/messages`,
      payload: { text: "Organize the team", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;
    expect(runtime.dynamicTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ponderosa_decision", "ponderosa_manage"]));

    const described = await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "describe" } });
    expect(described.success, described.text).toBe(true);
    expect(JSON.parse(described.text)).toMatchObject({ descendants: [expect.objectContaining({ agentId: child.id })] });
    const escaped = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "escape", operations: [{ kind: "rename_agent", targetAgentId: outsider.id, title: "Nope" }] },
    });
    expect(escaped.success).toBe(false);

    const planned = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "autonomous", operations: [
        { kind: "rename_agent", targetAgentId: child.id, title: "Renamed child" },
        { kind: "create_agent", ref: "reviewer", parentRef: child.id, title: "Reviewer", engine: "codex", instructions: "Review independently." },
      ] },
    });
    expect(planned.success, planned.text).toBe(true);
    const planId = JSON.parse(planned.text).planId as string;
    const applied = await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "apply", planId } });
    expect(applied.success, applied.text).toBe(true);
    expect(store.getAgent(child.id)?.title).toBe("Renamed child");
    const reviewer = store.listAgents(project.id).find((agent) => agent.title === "Reviewer")!;
    expect(reviewer.managerAgentId).toBe(child.id);
    expect(store.getImportedHistory(reviewer.id)?.messages[0]?.text).toBe("Review independently.");
    expect(JSON.parse((await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "apply", planId } })).text)).toMatchObject({ replayed: true });

    const unapprovedDelete = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "delete-no-decision", operations: [{ kind: "delete_agent", targetAgentId: reviewer.id }] },
    });
    expect(unapprovedDelete.success, unapprovedDelete.text).toBe(true);
    const unapprovedPlan = JSON.parse(unapprovedDelete.text) as { planId: string; approvalDecisionId: string };
    const decisionId = unapprovedPlan.approvalDecisionId;
    expect(store.sqlite.prepare(`SELECT plan_id, run_id, status FROM agent_management_approvals WHERE decision_id = ?`).get(decisionId)).toMatchObject({
      plan_id: unapprovedPlan.planId,
      run_id: store.getRuns(owner.id).at(-1)!.id,
      status: "pending",
    });
    persistent.completeSteers = false;
    expect((await app.inject({ method: "POST", url: `/api/decisions/${decisionId}/respond`, payload: { optionId: "approve" } })).statusCode).toBe(200);
    expect(store.sqlite.prepare(`SELECT status FROM agent_management_approvals WHERE decision_id = ?`).get(decisionId)).toEqual({ status: "approved" });
    await vi.waitFor(() => expect(persistent.steers).toHaveLength(1));
    const deleted = await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "apply", planId: unapprovedPlan.planId } });
    expect(deleted.success, deleted.text).toBe(true);
    expect(store.getAgent(reviewer.id)).toBeUndefined();
    expect(store.sqlite.prepare(`SELECT status FROM agent_management_approvals WHERE decision_id = ?`).get(decisionId)).toEqual({ status: "consumed" });

    const enabled = await app.inject({
      method: "PATCH", url: `/api/agents/${owner.id}`,
      payload: { managementPermissions: {
        allowAutomaticDescendantDeletion: true,
        allowAutomaticDescendantReorganization: true,
      } },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const branch = store.createAgent(project.id, { title: "Branch", engine: "codex", conversationId: conversation.id, managerAgentId: owner.id });
    const leaf = store.createAgent(project.id, { title: "Leaf", engine: "codex", conversationId: conversation.id, managerAgentId: child.id });
    const reorganizePlan = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "automatic-reorganize", operations: [
        { kind: "set_manager", targetAgentId: leaf.id, managerAgentId: branch.id },
      ] },
    });
    expect(reorganizePlan.success, reorganizePlan.text).toBe(true);
    expect((await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: JSON.parse(reorganizePlan.text).planId },
    })).success).toBe(true);
    expect(store.getAgent(leaf.id)?.managerAgentId).toBe(branch.id);
    const returnToOwnerPlan = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "reorganize-to-owner", operations: [
        { kind: "set_manager", targetAgentId: leaf.id, managerAgentId: owner.id },
      ] },
    });
    expect(returnToOwnerPlan.success, returnToOwnerPlan.text).toBe(true);
    expect((await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: JSON.parse(returnToOwnerPlan.text).planId },
    })).success).toBe(true);
    expect(store.getAgent(leaf.id)?.managerAgentId).toBe(owner.id);
    expect((await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "no-detach", operations: [
        { kind: "set_manager", targetAgentId: leaf.id, managerAgentId: null },
      ] },
    })).success).toBe(false);
    const restoreBranchPlan = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "restore-branch", operations: [
        { kind: "set_manager", targetAgentId: leaf.id, managerAgentId: branch.id },
      ] },
    });
    expect((await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: JSON.parse(restoreBranchPlan.text).planId },
    })).success).toBe(true);

    expect((await app.inject({
      method: "POST", url: `/api/agents/${branch.id}/messages`, payload: { text: "Keep working until cancelled" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    expect(store.getRuns(branch.id).at(-1)?.status).toBe("running");

    const autonomousDelete = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "automatic-delete", operations: [
        { kind: "delete_agent", targetAgentId: branch.id },
      ] },
    });
    expect(autonomousDelete.success, autonomousDelete.text).toBe(true);
    expect((await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: JSON.parse(autonomousDelete.text).planId },
    })).success).toBe(true);
    expect(store.getAgent(branch.id)).toBeUndefined();
    expect(store.getAgent(leaf.id)).toBeUndefined();
    expect(persistent.interrupted).toBeGreaterThanOrEqual(1);
    expect(persistent.closed).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("reauthorizes destructive plans at apply and rejects stale topology or unrelated approvals", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5, maxConcurrentRuns: 2 } });
    const project = store.createProject({ label: "Management authorization", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Team" });
    const owner = store.createAgent(project.id, {
      title: "Manager", engine: "codex", conversationId: conversation.id,
      managementPermissions: { allowAutomaticDescendantDeletion: true, allowAutomaticDescendantReorganization: true },
    });
    const branch = store.createAgent(project.id, { title: "Branch", engine: "codex", conversationId: conversation.id, managerAgentId: owner.id });
    const leaf = store.createAgent(project.id, { title: "Leaf", engine: "codex", conversationId: conversation.id, managerAgentId: branch.id });
    const outsider = store.createAgent(project.id, { title: "Outsider", engine: "codex", conversationId: conversation.id });
    expect((await app.inject({
      method: "POST", url: `/api/agents/${owner.id}/messages`,
      payload: { text: "Manage safely", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;

    const revocable = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "revocable-delete", operations: [{ kind: "delete_agent", targetAgentId: leaf.id }] },
    });
    const revocablePlanId = JSON.parse(revocable.text).planId as string;
    store.updateAgent(owner.id, { managementPermissions: {
      allowAutomaticDescendantDeletion: false,
      allowAutomaticDescendantReorganization: true,
    } });
    const revokedApply = await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "apply", planId: revocablePlanId } });
    expect(revokedApply.success).toBe(false);
    expect(revokedApply.text).toContain("permission was revoked");
    expect(store.getAgent(leaf.id)).toBeTruthy();

    store.updateAgent(owner.id, { managementPermissions: {
      allowAutomaticDescendantDeletion: true,
      allowAutomaticDescendantReorganization: true,
    } });
    const topologyPlan = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "ancestor-move", operations: [{ kind: "delete_agent", targetAgentId: leaf.id }] },
    });
    // The deletion root and its own manager edge are unchanged, so only an
    // apply-time owner-to-target authority check catches this ancestor move.
    store.updateAgentOrganization(branch.id, { managerAgentId: outsider.id });
    const topologyApply = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: JSON.parse(topologyPlan.text).planId },
    });
    expect(topologyApply.success).toBe(false);
    expect(topologyApply.text).toContain("no longer inside the owner's subtree");
    expect(store.getAgent(leaf.id)).toBeTruthy();

    store.updateAgentOrganization(branch.id, { managerAgentId: owner.id });
    store.updateAgent(owner.id, { managementPermissions: {
      allowAutomaticDescendantDeletion: false,
      allowAutomaticDescendantReorganization: true,
    } });
    const unrelated = await runtime.handleDynamicToolCall!({
      name: "ponderosa_decision",
      arguments: { idempotencyKey: "unrelated", mode: "approval", question: "Approve an unrelated action?" },
    });
    const unrelatedDecisionId = JSON.parse(unrelated.text).id as string;
    persistent.completeSteers = false;
    await app.inject({ method: "POST", url: `/api/decisions/${unrelatedDecisionId}/respond`, payload: { optionId: "approve" } });
    const scoped = await runtime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: { action: "plan", idempotencyKey: "scoped-delete", operations: [{ kind: "delete_agent", targetAgentId: leaf.id }] },
    });
    const scopedPlan = JSON.parse(scoped.text) as { planId: string; approvalDecisionId: string };
    expect(scopedPlan.approvalDecisionId).not.toBe(unrelatedDecisionId);
    const unrelatedApply = await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "apply", planId: scopedPlan.planId } });
    expect(unrelatedApply.success).toBe(false);
    expect(store.getAgent(leaf.id)).toBeTruthy();
    await app.inject({ method: "POST", url: `/api/decisions/${scopedPlan.approvalDecisionId}/respond`, payload: { optionId: "approve" } });
    expect((await runtime.handleDynamicToolCall!({ name: "ponderosa_manage", arguments: { action: "apply", planId: scopedPlan.planId } })).success).toBe(true);
    expect(store.getAgent(leaf.id)).toBeUndefined();
    await app.close();
  });

  it("binds a managed stop plan to the exact Run active at planning time", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false, communicationV3: { pollMs: 5, maxConcurrentRuns: 4 } });
    const project = store.createProject({ label: "Exact managed stop", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Team" });
    const owner = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const child = store.createAgent(project.id, {
      title: "Worker", engine: "codex", conversationId: conversation.id, managerAgentId: owner.id,
    });

    expect((await app.inject({
      method: "POST", url: `/api/agents/${owner.id}/messages`,
      payload: { text: "Manage the worker", sourceChannel: "main", sourceConversationId: conversation.id },
    })).statusCode).toBe(202);
    expect((await app.inject({
      method: "POST", url: `/api/agents/${child.id}/messages`, payload: { text: "Run A" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const ownerRuntime = persistent.openedOptions[0]!;
    const runA = new CoordinationV3Store(store.sqlite).agentSnapshot(child.id).activeRun!.id;
    const planned = await ownerRuntime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: {
        action: "plan", idempotencyKey: "stop-run-a",
        operations: [{ kind: "stop_agent", targetAgentId: child.id }],
      },
    });
    expect(planned.success, planned.text).toBe(true);
    const plan = JSON.parse(planned.text) as { planId: string; operations: Array<Record<string, unknown>> };
    expect(plan.operations[0]).not.toHaveProperty("targetRunId");

    expect((await app.inject({
      method: "POST", url: `/api/agents/${child.id}/cancel`,
      payload: { targetRunId: runA, idempotencyKey: "replace-run-a" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST", url: `/api/agents/${child.id}/messages`, payload: { text: "Run B" },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(3));
    const runB = new CoordinationV3Store(store.sqlite).agentSnapshot(child.id).activeRun!.id;
    expect(runB).not.toBe(runA);

    const staleApply = await ownerRuntime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: plan.planId },
    });
    expect(staleApply.success).toBe(false);
    expect(staleApply.text).toContain("exact Run bound to this stop_agent plan is no longer active");
    expect(new CoordinationV3Store(store.sqlite).agentSnapshot(child.id).activeRun?.id).toBe(runB);

    const currentPlan = await ownerRuntime.handleDynamicToolCall!({
      name: "ponderosa_manage",
      arguments: {
        action: "plan", idempotencyKey: "stop-run-b",
        operations: [{ kind: "stop_agent", targetAgentId: child.id }],
      },
    });
    expect(currentPlan.success, currentPlan.text).toBe(true);
    const currentApply = await ownerRuntime.handleDynamicToolCall!({
      name: "ponderosa_manage", arguments: { action: "apply", planId: JSON.parse(currentPlan.text).planId },
    });
    expect(currentApply.success, currentApply.text).toBe(true);
    expect(new CoordinationV3Store(store.sqlite).agentSnapshot(child.id).activeRun).toBeUndefined();
    await app.close();
  });

  it("exports and imports private context, source rules, and generated artifacts with collision-safe references", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Portable", hostPath: repoDir });
    store.updateProject(project.id, { instructions: "Destination-safe Project rule" });
    const sourceChat = store.createConversation(project.id, { title: "Source" });
    const destinationChat = store.createConversation(project.id, { title: "Destination" });
    const source = store.createAgent(project.id, {
      title: "Portable Agent", engine: "codex", conversationId: sourceChat.id,
      managementPermissions: {
        allowAutomaticDescendantDeletion: true,
        allowAutomaticDescendantReorganization: true,
      },
    });
    const portableCoordination = new CoordinationV3Store(store.sqlite);
    portableCoordination.createTriggerDefinition({
      id: "completed-one-time", projectId: project.id, conversationId: sourceChat.id, agentId: source.id,
      name: "Completed one-time schedule", instructions: "This historical schedule already completed.",
      sourceKind: "schedule", sourceConfig: { scheduleKind: "once", at: "2026-07-15T00:00:00.000Z" },
      enabled: false,
    });
    const artifactId = randomUUID();
    const bytes = Buffer.from("portable artifact bytes");
    const artifactFile = managedArtifactContentPath(dataDir, project.id, artifactId);
    mkdirSync(path.dirname(artifactFile), { recursive: true });
    writeFileSync(artifactFile, bytes);
    store.recordProjectArtifact({
      id: artifactId, projectId: project.id, agentId: source.id, originAgentId: source.id,
      kind: "generated_file", path: `generated/${artifactId}.txt`, summary: "result.txt", createdAt: "2026-07-16T00:00:00.000Z",
      mediaType: "text/plain", visibility: "project", pinned: false, size: bytes.length,
    });
    store.setImportedHistory(source.id, "prior system", [{ role: "user", text: `Retrieve artifact ${artifactId}`, createdAt: "2026-07-16T00:00:01.000Z" }]);
    const exported = await app.inject({ method: "GET", url: `/api/agents/${source.id}/export?mode=full` });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json()).toMatchObject({
      sourceProjectInstructions: "Destination-safe Project rule",
      agents: [{
        managementPermissions: source.managementPermissions,
        artifacts: [{ ref: artifactId, dataBase64: bytes.toString("base64") }],
      }],
    });
    const template = await app.inject({ method: "GET", url: `/api/agents/${source.id}/export?mode=template` });
    expect(template.json()).toMatchObject({
      mode: "template",
      agents: [{ title: "Portable Agent", managementPermissions: source.managementPermissions }],
    });
    expect(template.body).not.toContain("sourceProjectInstructions");
    expect(template.body).not.toContain("history");
    expect(template.body).not.toContain("artifacts");
    expect(template.body).not.toContain("triggers");
    const legacyContext = await app.inject({ method: "GET", url: `/api/agents/${source.id}/export?mode=context` });
    expect(legacyContext.json()).toMatchObject({ mode: "full", agents: [{ artifacts: expect.any(Array), triggers: expect.any(Array) }] });
    const portablePackage = exported.json<AgentPortablePackageDto>();
    portablePackage.sourceProjectInstructions = "SOURCE-RULE-MUST-NOT-ENTER-PROVIDER-CONTEXT";
    const malformedPermissions = structuredClone(portablePackage) as AgentPortablePackageDto;
    (malformedPermissions.agents[0]!.managementPermissions as unknown as Record<string, unknown>).allowAutomaticDescendantDeletion = "false";
    const malformedImport = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/import-agents`,
      payload: { package: malformedPermissions, conversationId: destinationChat.id, engineMapping: { codex: "codex" }, acknowledgeElevatedManagementPermissions: true },
    });
    expect(malformedImport.statusCode, malformedImport.body).toBe(400);
    const unacknowledgedImport = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/import-agents`,
      payload: { package: portablePackage, conversationId: destinationChat.id, engineMapping: { codex: "codex" } },
    });
    expect(unacknowledgedImport.statusCode, unacknowledgedImport.body).toBe(409);
    const imported = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/import-agents`,
      payload: { package: portablePackage, conversationId: destinationChat.id, engineMapping: { codex: "codex" }, acknowledgeElevatedManagementPermissions: true },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const importedAgentId = imported.json<{ rootAgentId: string }>().rootAgentId;
    expect(store.getAgent(importedAgentId)?.managementPermissions).toEqual(source.managementPermissions);
    const importedArtifacts = store.getProjectArtifacts(project.id).filter((artifact) => artifact.originAgentId === importedAgentId);
    expect(importedArtifacts).toHaveLength(1);
    expect(importedArtifacts[0]!.id).not.toBe(artifactId);
    expect(readFileSync(managedArtifactContentPath(dataDir, project.id, importedArtifacts[0]!.id))).toEqual(bytes);
    expect(store.getImportedHistory(importedAgentId)?.messages.map((message) => message.text).join("\n")).toContain(importedArtifacts[0]!.id);
    expect(store.getImportedHistory(importedAgentId)?.messages.map((message) => message.text).join("\n"))
      .not.toContain("Historical source Project rules");
    expect(portableCoordination.listTriggerDefinitions(importedAgentId)).toEqual([
      expect.objectContaining({
        enabled: false,
        name: "Completed one-time schedule",
        sourceConfig: { scheduleKind: "once", at: "2026-07-15T00:00:00.000Z" },
      }),
    ]);
    adapter.mode = "hang";
    expect((await app.inject({ method: "POST", url: `/api/agents/${importedAgentId}/messages`, payload: { text: "Inspect imported state" } })).statusCode).toBe(202);
    await waitForSeedCount(1);
    expect(adapter.seeds[0]!.prompt).toContain("Destination-safe Project rule");
    expect(JSON.stringify(adapter.seeds[0])).not.toContain("SOURCE-RULE-MUST-NOT-ENTER-PROVIDER-CONTEXT");
    expect(adapter.seeds[0]!.history?.flatMap((message) => message.attachments ?? [])).toContainEqual(expect.objectContaining({
      artifactId: importedArtifacts[0]!.id,
      localPath: managedArtifactContentPath(dataDir, project.id, importedArtifacts[0]!.id),
      available: true,
    }));
    await app.inject({
      method: "POST", url: `/api/agents/${importedAgentId}/cancel`,
      payload: activeRunCancellationPayload(store, importedAgentId, "stop-import-inspection"),
    });
    await app.close();
  });
});
