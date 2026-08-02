import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Adapter,
  AgentEvent,
  CommunicationEvent,
  ContinueOptions,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  SeedOptions,
} from "@ponderosa/core";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { ClaudeAdapter } from "@ponderosa/engines";
import { secureFileAuthoritySupported } from "@ponderosa/native-host";
import { createServer, type EngineRegistration } from "../src/app.js";

class BehavioralAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Behavioral adapter";
  seedCalls = 0;
  seedOptions: SeedOptions[] = [];

  listModels() {
    return [{ id: "test-model", label: "Test model" }];
  }

  listEfforts() {
    return [{ id: "high", label: "High" }];
  }

  async *seed(options: SeedOptions): AsyncIterable<AgentEvent> {
    this.seedCalls += 1;
    this.seedOptions.push(options);
    yield { type: "turn_done" };
  }

  async *continue(_options: ContinueOptions): AsyncIterable<AgentEvent> {
    yield { type: "turn_done" };
  }
}

class MissingRolloverHandoffAdapter extends BehavioralAdapter {
  override async *seed(options: SeedOptions): AsyncIterable<AgentEvent> {
    this.seedCalls += 1;
    this.seedOptions.push(options);
    yield { type: "session", sessionId: "missing-handoff-session" };
    yield {
      type: "context_usage",
      providerSessionId: "missing-handoff-session",
      providerSessionGeneration: "missing-handoff-generation",
      usedTokens: 80_000,
      aggregateTokens: 10_000_000,
      windowTokens: 200_000,
    };
    yield { type: "turn_done" };
  }
}

class CrossChatPersistentAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Cross-chat persistent adapter";
  openOptions: OpenRuntimeSessionOptions[] = [];
  startCalls = 0;
  toolResult?: { success: boolean; text: string };
  readonly responseText = "The private token is BLUE-ALBATROSS.";

  listModels() { return [{ id: "test-model", label: "Test model" }]; }
  listEfforts() { return [{ id: "high", label: "High" }]; }

  async *seed(_options: SeedOptions): AsyncIterable<AgentEvent> {
    throw new Error("persistent fixture must use openSession");
  }

  async *continue(_options: ContinueOptions): AsyncIterable<AgentEvent> {
    throw new Error("persistent fixture must use openSession");
  }

  async openSession(options: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.openOptions.push(options);
    const adapter = this;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let closed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
    let alive = true;
    const session: RuntimeSession = {
      engineAgentId: "cross-chat-session",
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          yield { type: "session", sessionId: "cross-chat-session" };
          await startedPromise;
          adapter.toolResult = await options.handleDynamicToolCall?.({
            name: "ponderosa_message",
            arguments: { text: "The private token is BLUE-ALBATROSS." },
          });
          yield { type: "turn_done" };
          await closedPromise;
        },
      },
      startTurn: async () => {
        this.startCalls += 1;
        started();
        return { turnId: "cross-chat-turn" };
      },
      steer: async () => ({ status: "not_active" }),
      interrupt: async () => undefined,
      isAlive: () => alive,
      close: async () => {
        alive = false;
        closed();
      },
    };
    options.onRuntimeSpawned(session);
    return session;
  }
}

class ManualRolloverPersistentAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Manual rollover persistent adapter";
  openCount = 0;
  rolloverCalls = 0;
  toolResult?: { success: boolean; text: string };
  readonly handoff = Array.from({ length: 300 }, (_, index) => `handoff-${index + 1}`).join(" ");

  listModels() { return [{ id: "test-model", label: "Test model" }]; }
  listEfforts() { return [{ id: "high", label: "High" }]; }
  async *seed(_options: SeedOptions): AsyncIterable<AgentEvent> {
    throw new Error("manual rollover fixture must use openSession");
  }
  async *continue(_options: ContinueOptions): AsyncIterable<AgentEvent> {
    throw new Error("manual rollover fixture must use openSession");
  }

  async openSession(options: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.openCount += 1;
    const generation = this.openCount === 1 ? "manual-old-generation" : "manual-fresh-generation";
    const sessionId = this.openCount === 1 ? "manual-old-session" : "manual-fresh-session";
    const shouldRequestRollover = this.openCount === 1;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let closed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
    let alive = true;
    const fixture = this;
    const session: RuntimeSession = {
      engineAgentId: sessionId,
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          yield { type: "session", sessionId };
          await startedPromise;
          if (shouldRequestRollover) {
            fixture.rolloverCalls += 1;
            fixture.toolResult = await options.handleDynamicToolCall?.({
              name: "ponderosa_rollover",
              arguments: { handoff: fixture.handoff },
            });
          } else {
            yield {
              type: "context_usage",
              providerSessionId: sessionId,
              providerSessionGeneration: generation,
              usedTokens: 20_000,
              aggregateTokens: 120_000,
              windowTokens: 200_000,
            };
          }
          yield { type: "turn_done" };
          await closedPromise;
        },
      },
      startTurn: async () => {
        started();
        return { turnId: `${generation}-turn` };
      },
      contextUsage: () => ({
        usedTokens: shouldRequestRollover ? 80_000 : 20_000,
        aggregateTokens: 10_000_000,
        windowTokens: 200_000,
        providerSessionGeneration: generation,
      }),
      steer: async () => ({ status: "not_active" }),
      interrupt: async () => undefined,
      isAlive: () => alive,
      close: async () => {
        alive = false;
        closed();
      },
    };
    options.onRuntimeSpawned(session);
    return session;
  }
}

describe("server public API behavior", () => {
  let dataDir: string;
  let repoDir: string;
  let store: AgentStore;
  let engines: EngineRegistration[];
  const apps: Array<ReturnType<typeof createServer>> = [];
  const extraDirectories: string[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-server-behavior-"));
    repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-server-project-"));
    writeFileSync(path.join(repoDir, "README.md"), "# fixture\n", "utf8");
    store = new AgentStore(dataDir);
    engines = [{
      adapter: new BehavioralAdapter(),
      authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
    }];
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      await app.close().catch(() => undefined);
    }
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    for (const directory of extraDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function server(options: Parameters<typeof createServer>[0] = {
    dataDir,
    store,
    engines,
    logger: false,
  }) {
    const app = createServer(options);
    apps.push(app);
    return app;
  }

  it("separates daemon liveness from work readiness", async () => {
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      buildRevision: "test-revision-123",
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
    const descriptorFilesystemAvailable = secureFileAuthoritySupported();
    expect(ready.statusCode).toBe(descriptorFilesystemAvailable ? 200 : 503);
    expect(ready.json()).toMatchObject({
      status: descriptorFilesystemAvailable ? "ready" : "not_ready",
      canAcceptWork: descriptorFilesystemAvailable,
      acceptingDurableIntake: descriptorFilesystemAvailable,
      leasingRuns: descriptorFilesystemAvailable,
      checks: {
        daemon: { ok: true },
        dataDirectory: { ok: true },
        projections: { ok: true },
        artifactFilesystem: { ok: descriptorFilesystemAvailable },
      },
      runtimes: [{ id: "codex", authenticated: true }],
    });
  });

  it("survives a missing Claude executable during model discovery", async () => {
    const project = store.createProject({
      label: "Missing Claude",
      hostPath: repoDir,
      defaultEngine: "claude",
    });
    const app = server({
      dataDir,
      store,
      engines: [{
        adapter: new ClaudeAdapter({
          bin: path.join(dataDir, "missing-claude"),
          killGraceMs: 0,
        }),
        authStatus: async () => ({
          authenticated: false,
          detail: "Claude executable is unavailable",
        }),
      }],
      logger: false,
    });

    const discovery = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-models/claude?refresh=true`,
    });
    expect(discovery.statusCode).toBe(503);
    expect(discovery.json()).toEqual(expect.objectContaining({
      error: expect.any(String),
    }));

    await new Promise<void>((resolve) => setImmediate(resolve));
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", service: "ponderosa" });
  });

  it("validates and persists the workspace-wide Run concurrency limit", async () => {
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 },
    });

    const initial = await app.inject({ method: "GET", url: "/api/workspace/preferences" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      maxConcurrentAgentRuns: 8,
      onboardingCompletedAt: null,
    });

    for (const maxConcurrentAgentRuns of [0, 65, 1.5, "4"]) {
      const rejected = await app.inject({
        method: "PATCH",
        url: "/api/workspace/preferences",
        payload: { maxConcurrentAgentRuns },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({
        error: expect.stringContaining("integer from 1 to 64"),
      });
    }

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/workspace/preferences",
      payload: {
        maxConcurrentAgentRuns: 3,
        onboardingCompletedAt: "2026-07-21T00:00:00.000Z",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      maxConcurrentAgentRuns: 3,
      onboardingCompletedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(new WorkspaceStore(dataDir).getPreferences()).toMatchObject({
      maxConcurrentAgentRuns: 3,
      onboardingCompletedAt: "2026-07-21T00:00:00.000Z",
    });
  });

  it("creates managed workspaces and never deletes a selected source folder", async () => {
    const app = server();
    const managed = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Managed", defaultEngine: "codex" },
    });
    expect(managed.statusCode, managed.body).toBe(200);
    const managedProject = managed.json<{ id: string; hostPath: string }>();
    expect(managedProject.hostPath.startsWith(path.join(dataDir, "workspaces", "project-"))).toBe(true);
    expect(existsSync(managedProject.hostPath)).toBe(true);

    const selected = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Selected", hostPath: repoDir, defaultEngine: "codex" },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    const selectedProject = selected.json<{ id: string; hostPath: string }>();
    expect(selectedProject.hostPath).toBe(realpathSync(repoDir));

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${selectedProject.id}`,
      payload: { label: "Renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      id: selectedProject.id,
      label: "Renamed",
      hostPath: realpathSync(repoDir),
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${selectedProject.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("# fixture\n");
    expect((await app.inject({
      method: "GET",
      url: `/api/files?projectId=${selectedProject.id}`,
    })).statusCode).toBe(404);
  });

  it("bounds host-folder browsing and creation to configured roots", async () => {
    const browseRoot = mkdtempSync(path.join(tmpdir(), "ponderosa-server-browse-"));
    const outside = mkdtempSync(path.join(tmpdir(), "ponderosa-server-browse-outside-"));
    extraDirectories.push(browseRoot, outside);
    mkdirSync(path.join(browseRoot, "existing"));
    await import("node:fs").then(({ symlinkSync }) => {
      symlinkSync(outside, path.join(browseRoot, "outside-link"));
    });
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      allowedBrowseRoots: [browseRoot],
    });

    const defaultBrowse = await app.inject({
      method: "GET",
      url: "/api/project-folders/browse",
    });
    expect(defaultBrowse.statusCode).toBe(200);
    expect(defaultBrowse.json()).toEqual({
      path: realpathSync(browseRoot),
      root: realpathSync(browseRoot),
      folders: [{
        name: "existing",
        hostPath: realpathSync(path.join(browseRoot, "existing")),
      }],
    });

    const outsideBrowse = await app.inject({
      method: "GET",
      url: `/api/project-folders/browse?path=${encodeURIComponent(outside)}`,
    });
    expect(outsideBrowse.statusCode).toBe(400);
    expect(outsideBrowse.json()).toEqual({
      error: "path is outside configured browse roots",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/project-folders/create",
      payload: { parentPath: browseRoot, name: "new project" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({
      name: "new project",
      hostPath: realpathSync(path.join(browseRoot, "new project")),
    });
    expect((await app.inject({
      method: "POST",
      url: "/api/project-folders/create",
      payload: { parentPath: browseRoot, name: "new project" },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: "/api/project-folders/create",
      payload: { parentPath: browseRoot, name: "../escape" },
    })).statusCode).toBe(400);
  });

  it("rejects cross-origin mutations while accepting the same origin", async () => {
    const app = server();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://evil.test" },
      payload: { label: "Rejected", hostPath: repoDir, defaultEngine: "codex" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://ponderosa.test" },
      payload: { label: "Accepted", hostPath: repoDir, defaultEngine: "codex" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
  });

  it("bounds file reads and rejects traversal and symlink escapes", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "ponderosa-server-outside-"));
    extraDirectories.push(outside);
    writeFileSync(path.join(outside, "secret.txt"), "secret\n", "utf8");
    writeFileSync(path.join(repoDir, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(path.join(repoDir, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await import("node:fs").then(({ symlinkSync }) => {
      symlinkSync(outside, path.join(repoDir, "outside-link"));
    });
    const project = store.createProject({ label: "Files", hostPath: repoDir });
    const app = server();

    const traversal = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=../outside`,
    });
    const symlink = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=outside-link/secret.txt`,
    });
    const large = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=large.bin`,
    });
    const binary = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=binary.bin`,
    });

    expect(traversal.statusCode).toBe(400);
    expect(symlink.statusCode).toBe(400);
    expect(large.json()).toEqual({ error: "file exceeds 2 MiB browser limit" });
    expect(binary.json()).toMatchObject({ encoding: "base64", content: "//79" });
  });

  it("serves the web build with SPA fallback and scoped cache policy", async () => {
    const webDist = mkdtempSync(path.join(tmpdir(), "ponderosa-server-web-"));
    extraDirectories.push(webDist);
    mkdirSync(path.join(webDist, "assets"));
    mkdirSync(path.join(webDist, "static", "js"), { recursive: true });
    writeFileSync(path.join(webDist, "index.html"), "<main>app</main>", "utf8");
    writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app');\n", "utf8");
    writeFileSync(path.join(webDist, "static", "js", "app.123.js"), "console.log('fingerprinted');\n", "utf8");
    const app = server({ dataDir, store, engines, webDist, logger: false });

    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    const fingerprinted = await app.inject({ method: "GET", url: "/static/js/app.123.js" });
    const fallback = await app.inject({ method: "GET", url: "/agents/abc" });
    const apiMiss = await app.inject({ method: "GET", url: "/api/not-real" });

    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["x-frame-options"]).toBe("DENY");
    expect(index.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(asset.headers["cache-control"]).toBe("public, max-age=3600");
    expect(fingerprinted.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(fallback.body).toContain("<main>app</main>");
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.body).not.toContain("<main>app</main>");
  });

  it("allows unauthenticated PWA updates without exposing APIs or SPA routes", async () => {
    const webDist = mkdtempSync(path.join(tmpdir(), "ponderosa-server-pwa-"));
    extraDirectories.push(webDist);
    mkdirSync(path.join(webDist, "static", "js"), { recursive: true });
    mkdirSync(path.join(webDist, "icons"), { recursive: true });
    for (const [relative, body] of [
      ["index.html", "<main>current shell</main>"],
      ["sw.js", "self.addEventListener('install', () => undefined);"],
      ["register-sw.js", "navigator.serviceWorker.register('/sw.js');"],
      ["push-handler.js", "self.addEventListener('push', () => undefined);"],
      ["manifest.webmanifest", "{}"],
      [path.join("static", "js", "current.123.js"), "console.log('current');"],
      [path.join("icons", "app-icon.png"), "fixture"],
    ]) {
      writeFileSync(path.join(webDist, relative), body, "utf8");
    }
    const app = server({
      dataDir,
      store,
      engines,
      webDist,
      logger: false,
      authToken: "api-secret",
      launcherSecurity: { controlToken: "launcher-secret" },
    });

    for (const url of [
      "/index.html",
      "/sw.js",
      "/register-sw.js",
      "/push-handler.js",
      "/manifest.webmanifest",
      "/static/js/current.123.js",
      "/icons/app-icon.png",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
    }

    const updateHead = await app.inject({ method: "HEAD", url: "/sw.js?update=1" });
    expect(updateHead.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/agents/stale-route" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/projects" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/sw.js" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api-lookalike.js" })).statusCode).toBe(401);
  });

  it("lets the scheduler dispatch Agent work in launcher-authenticated mode", async () => {
    const adapter = new BehavioralAdapter();
    const project = store.createProject({
      label: "Installed",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const agent = store.createAgent(project.id, {
      title: "Installed Agent",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const app = server({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      launcherSecurity: { controlToken: "launcher-secret" },
      communicationV3: { pollMs: 5 },
    });

    expect((await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      headers: { "x-ponderosa-v3-dispatch": "forged-dispatch-key" },
      payload: { text: "Bypass launcher authentication." },
    })).statusCode).toBe(401);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/launcher/bootstrap",
      headers: { authorization: "Bearer launcher-secret" },
    });
    const exchange = await app.inject({
      method: "POST",
      url: "/api/launcher/session-exchange",
      payload: { token: bootstrap.json<{ token: string }>().token },
    });
    const cookie = exchange.headers["set-cookie"];
    expect(exchange.statusCode).toBe(204);
    expect(typeof cookie).toBe("string");

    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      headers: { cookie: cookie as string },
      payload: { text: "Confirm installed dispatch." },
    });
    expect(sent.statusCode).toBe(202);

    const deadline = Date.now() + 2_000;
    while (adapter.seedCalls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(adapter.seedCalls).toBe(1);
  });

  it("reseeds cross-chat Agent-private Direct history, records its source, and replies in the requesting chat", async () => {
    const adapter = new CrossChatPersistentAdapter();
    const project = store.createProject({
      label: "Multi Chat",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const homeId = project.lastConversationId!;
    const blue = store.createConversation(project.id, { title: "Channel Blue" });
    const red = store.createConversation(project.id, { title: "Channel Red" });
    const agent = store.createAgent(project.id, {
      title: "Multi-Chat Probe",
      engine: "codex",
      conversationId: homeId,
    });
    const other = store.createAgent(project.id, {
      title: "Other Agent",
      engine: "codex",
      conversationId: red.id,
    });
    store.updateAgentConversationMemberships(agent.id, {
      conversationIds: [homeId, blue.id],
      primaryConversationId: homeId,
    });
    const app = server({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });
    const blueSent = await app.inject({
      method: "POST",
      url: `/api/conversations/${blue.id}/direct-messages`,
      payload: {
        text: "Remember the private token BLUE-ALBATROSS.",
        recipients: [{ agentId: agent.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(blueSent.statusCode, blueSent.body).toBe(200);
    const blueMessageId = blueSent.json<{ messageId: string }>().messageId;
    const blueDirectMessage = store.getConversationMessages(blue.id, "main")
      .find((message) => message.id === blueMessageId)!;
    const blueDirect = store.getCommunicationEvent(
      project.id,
      blueDirectMessage.communicationEventId!,
    )!;
    const blueDeadline = Date.now() + 3_000;
    while (!adapter.toolResult && Date.now() < blueDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(adapter.toolResult?.success).toBe(true);
    const blueAgentResponseId = JSON.parse(adapter.toolResult!.text) as { eventId: string };
    expect(store.getCommunicationEvent(project.id, blueAgentResponseId.eventId)?.identity).toMatchObject({
      senderLabel: "Multi-Chat Probe",
      conversationLabel: "Channel Blue",
    });
    adapter.toolResult = undefined;
    store.updateConversation(blue.id, { title: "Renamed Blue" });
    store.updateAgent(agent.id, { title: "Renamed Probe" });
    const otherDirect: CommunicationEvent = {
      eventId: "red-other-source",
      schemaVersion: 2,
      projectId: project.id,
      conversationId: red.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: other.id },
      text: "OTHER-AGENT-SECRET",
      createdAt: "2026-08-01T12:01:00.000Z",
    };
    store.appendCommunicationEvent(otherDirect);
    store.appendEvent(other.id, {
      type: "user_message",
      text: otherDirect.text,
      communicationEventId: otherDirect.eventId,
    });
    const redBroadcast: CommunicationEvent = {
      eventId: "red-shared-source",
      schemaVersion: 2,
      projectId: project.id,
      conversationId: red.id,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "RED-SHARED-CONTENT",
      createdAt: "2026-08-01T12:02:00.000Z",
    };
    store.appendCommunicationEvent(redBroadcast);
    store.appendCommunicationProjection(project.id, {
      eventId: redBroadcast.eventId,
      surface: "conversation",
      projectionKey: red.id,
      projectedAt: redBroadcast.createdAt,
      message: { messageId: "red-shared-message", role: "user", createdAt: redBroadcast.createdAt },
    });

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${homeId}/direct-messages`,
      payload: {
        text: "What private token did I give you in Channel Blue?",
        recipients: [{ agentId: agent.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);

    const deadline = Date.now() + 3_000;
    while (adapter.startCalls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(adapter.startCalls).toBe(2);
    const submittedHistory = adapter.openOptions[1]!.history.map((message) => message.text).join("\n");
    expect(submittedHistory).toContain("BLUE-ALBATROSS");
    expect(submittedHistory).toContain(`origin chat: Channel Blue (${blue.id})`);
    expect(submittedHistory).toContain("author: Multi-Chat Probe");
    expect(submittedHistory).not.toContain(otherDirect.text);
    expect(submittedHistory).not.toContain(redBroadcast.text);

    const runDeadline = Date.now() + 3_000;
    let providerInput = store.getRuns(agent.id)
      .map((run) => store.getProviderInput(run.id, true))
      .find((input) => input?.exactPrompt.includes("What private token did I give you"));
    while (!providerInput && Date.now() < runDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      providerInput = store.getRuns(agent.id)
        .map((run) => store.getProviderInput(run.id, true))
        .find((input) => input?.exactPrompt.includes("What private token did I give you"));
    }
    expect(providerInput?.sourceManifest.communicationEventIds).toContain(blueDirect.eventId);
    expect(providerInput?.sourceManifest.communicationEventIds).toContain(blueAgentResponseId.eventId);
    expect(providerInput?.sourceManifest.sources).toContainEqual(expect.objectContaining({
      kind: "communication",
      ref: blueDirect.eventId,
      conversationId: blue.id,
      conversationTitle: blue.title,
      author: "User",
      communicationIntent: "user_dm",
    }));
    expect(providerInput?.sourceManifest.sources).toContainEqual(expect.objectContaining({
      kind: "communication",
      ref: blueAgentResponseId.eventId,
      conversationId: blue.id,
      conversationTitle: "Channel Blue",
      author: "Multi-Chat Probe",
      communicationIntent: "user_dm",
    }));
    expect(providerInput?.exactPrompt).toContain("BLUE-ALBATROSS");

    expect(adapter.toolResult?.success).toBe(true);
    const responseEventId = JSON.parse(adapter.toolResult!.text) as { eventId: string };
    const responseDeadline = Date.now() + 3_000;
    let response = store.getConversationMessages(homeId, "main")
      .find((message) => message.communicationEventId === responseEventId.eventId);
    while (!response && Date.now() < responseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      response = store.getConversationMessages(homeId, "main")
        .find((message) => message.communicationEventId === responseEventId.eventId);
    }
    expect(response, adapter.toolResult?.text).toMatchObject({ role: "assistant", authorAgentId: agent.id });
    expect(store.getCommunicationEvent(project.id, response!.communicationEventId!)).toMatchObject({
      conversationId: homeId,
      intent: "user_dm",
      sender: { kind: "agent", agentId: agent.id },
    });
    const home = await app.inject({ method: "GET", url: `/api/conversations/${homeId}` });
    expect(home.json<{ messages: Array<{ communicationEventId?: string; text: string }> }>()
      .messages.find((message) => message.communicationEventId === responseEventId.eventId)?.text)
      .toBe(`#user ${adapter.responseText}`);
  });

  it("fails visibly when pressure-triggered rollover ends without its required handoff", async () => {
    const workspace = new WorkspaceStore(dataDir);
    workspace.updatePreferences({
      contextRolloverEnabled: true,
      contextRolloverTokens: 75_000,
      contextRolloverWindowFraction: 0.7,
    });
    const adapter = new MissingRolloverHandoffAdapter();
    const project = store.createProject({
      label: "Missing rollover handoff",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const agent = store.createAgent(project.id, {
      title: "Handoff Probe",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const app = server({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });
    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Continue the long task", idempotencyKey: randomUUID() },
    });
    expect(sent.statusCode, sent.body).toBe(202);

    const deadline = Date.now() + 3_000;
    let failure = store.readEvents(agent.id).find((stored) =>
      stored.event.type === "error"
      && stored.event.message.includes("before committing the required bounded handoff"));
    while (!failure && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      failure = store.readEvents(agent.id).find((stored) =>
        stored.event.type === "error"
        && stored.event.message.includes("before committing the required bounded handoff"));
    }
    expect(failure).toBeDefined();
    expect(store.latestHealthObservation(agent.id)).toMatchObject({
      status: "failed",
      reason: "runtime_error",
    });
    const rollover = (store.sqlite.prepare(`
      SELECT id, state, last_error AS lastError FROM context_rollovers
      WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(agent.id) as { id: string; state: string; lastError: string });
    expect(rollover).toMatchObject({
      state: "failed",
      lastError: expect.stringContaining("before committing the required bounded handoff"),
    });
    const notifications = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(notifications.json<Array<{ dedupeKey?: string; title: string; body: string }>>())
      .toContainEqual(expect.objectContaining({
        dedupeKey: `context-rollover:${rollover.id}:handoff-missing`,
        title: "Handoff Probe could not refresh context",
        body: expect.stringContaining("Retry the task"),
      }));

    const coordination = new CoordinationV3Store(store.sqlite);
    const retry = coordination.requestContextRollover({
      projectId: project.id,
      agentId: agent.id,
      oldProviderSessionId: "missing-handoff-session",
      providerSessionGeneration: "missing-handoff-generation",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      contextWindow: 200_000,
      lowWaterMark: 45_000,
      sourceRunId: "bounded-manual-retry",
      sourceActivationIds: [],
      scopeKey: `conversation:${project.lastConversationId}`,
      conversationId: project.lastConversationId,
    });
    expect(retry).toMatchObject({ created: true });
    coordination.commitContextRolloverHandoff(retry.rollover.id, "bounded-manual-retry-handoff");
    expect(coordination.commitContextRolloverHandoff(
      retry.rollover.id,
      "bounded-manual-retry-handoff",
    )).toMatchObject({ id: retry.rollover.id, state: "handoff_committed" });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'context_rollover_handoff' AND state IN ('pending','retry_pending')
        AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_kind = 'context_rollover' AND source_id = ?
        )
    `).get(retry.rollover.id)).toEqual({ count: 0 });
  });

  it("retries a failed provider generation through one bounded manual rollover tool call", async () => {
    const adapter = new ManualRolloverPersistentAdapter();
    const project = store.createProject({
      label: "Manual rollover retry",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const agent = store.createAgent(project.id, {
      title: "Manual Retry Probe",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    const failed = coordination.requestContextRollover({
      projectId: project.id,
      agentId: agent.id,
      oldProviderSessionId: "manual-old-session",
      providerSessionGeneration: "manual-old-generation",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      contextWindow: 200_000,
      lowWaterMark: 45_000,
      sourceRunId: "previous-failed-run",
      sourceActivationIds: [],
      scopeKey: `conversation:${project.lastConversationId}`,
      conversationId: project.lastConversationId,
    }).rollover;
    coordination.failContextRollover(
      failed.id,
      "failed",
      "provider ended before handoff",
    );

    const app = server({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });
    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Resume after the failed refresh", idempotencyKey: randomUUID() },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const deadline = Date.now() + 3_000;
    while ((adapter.openCount < 2 || !adapter.toolResult) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(adapter.toolResult).toMatchObject({ success: true });
    expect(adapter.rolloverCalls).toBe(1);
    expect(adapter.handoff.split(/\s+/u)).toHaveLength(300);
    expect(adapter.openCount).toBe(2);

    const attempts = store.sqlite.prepare(`
      SELECT id, state, source_run_id AS sourceRunId, handoff_event_id AS handoffEventId
      FROM context_rollovers
      WHERE agent_id = ? AND provider_session_generation = 'manual-old-generation'
      ORDER BY rowid
    `).all(agent.id) as Array<{
      id: string; state: string; sourceRunId: string; handoffEventId: string | null;
    }>;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ id: failed.id, state: "failed" });
    expect(attempts[1]).toMatchObject({ state: "completed" });
    expect(attempts[1]!.handoffEventId).toEqual(expect.any(String));
    expect(store.continuationHandoffForRollover(
      agent.id,
      attempts[1]!.handoffEventId!,
      attempts[1]!.sourceRunId,
    )?.text).toBe(adapter.handoff);
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'context_rollover_handoff' AND state IN ('pending','retry_pending')
        AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_kind = 'context_rollover' AND source_id = ?
        )
    `).get(attempts[1]!.id)).toEqual({ count: 0 });
  });

  it.each(["handoff_committed", "session_retiring"] as const)(
    "recovers %s with the exact crashed-Run handoff in fresh provider input",
    async (restartState) => {
      const adapter = new BehavioralAdapter();
      const project = store.createProject({
        label: `Rollover restart ${restartState}`,
        hostPath: repoDir,
        defaultEngine: "codex",
      });
      const agent = store.createAgent(project.id, {
        title: "Restart Probe",
        engine: "codex",
        conversationId: project.lastConversationId,
      });
      const sourceRunId = `crashed-source-${restartState}`;
      const handoffId = `crashed-handoff-${restartState}`;
      const exactHandoff = `EXACT-${restartState}-HANDOFF preserve the verified next action once.`;
      store.appendEvent(agent.id, {
        type: "agent_lifecycle",
        status: "running",
        reason: "active_run",
        executionId: sourceRunId,
      });
      store.appendEvent(agent.id, {
        type: "session_snapshot",
        sessionId: `old-session-${restartState}`,
        artifactIds: [],
      });
      store.appendEvent(agent.id, {
        type: "continuation_handoff",
        handoffId,
        executionId: sourceRunId,
        text: exactHandoff,
      });
      const coordination = new CoordinationV3Store(store.sqlite);
      const rollover = coordination.requestContextRollover({
        projectId: project.id,
        agentId: agent.id,
        oldProviderSessionId: `old-session-${restartState}`,
        providerSessionGeneration: `old-generation-${restartState}`,
        detectedOccupancy: 80_000,
        threshold: 75_000,
        lowWaterMark: 45_000,
        sourceRunId,
        sourceActivationIds: [],
        scopeKey: `conversation:${project.lastConversationId}`,
        conversationId: project.lastConversationId,
      }).rollover;
      coordination.commitContextRolloverHandoff(rollover.id, handoffId);
      if (restartState === "session_retiring") {
        coordination.beginContextRolloverRetirement(rollover.id);
      }

      const app = server({
        dataDir,
        store,
        engines: [{
          adapter,
          authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
        }],
        logger: false,
        communicationV3: { pollMs: 5 },
      });
      await app.ready();
      const deadline = Date.now() + 3_000;
      while (adapter.seedCalls === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(adapter.seedCalls).toBe(1);
      expect(adapter.seedOptions[0]?.prompt).toContain(exactHandoff);
      expect(store.readEvents(agent.id)).toContainEqual(expect.objectContaining({
        event: expect.objectContaining({
          type: "agent_lifecycle",
          status: "failed",
          reason: "execution_interrupted",
          executionId: sourceRunId,
        }),
      }));
      const consumptionDeadline = Date.now() + 3_000;
      while (!store.continuationHandoffForRun(agent.id, sourceRunId)?.consumedAt &&
          Date.now() < consumptionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(store.continuationHandoffForRun(agent.id, sourceRunId)?.consumedAt)
        .toEqual(expect.any(String));
      expect(store.readEvents(agent.id).filter((stored) =>
        stored.event.type === "continuation_handoff_consumed"
        && stored.event.handoffId === handoffId)).toHaveLength(1);
    },
  );

  it("exposes bounded Engine diagnostics only to its native launcher", async () => {
    const launcherDataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-engine-data-"));
    extraDirectories.push(launcherDataDir);
    const logsDir = path.join(launcherDataDir, "logs");
    mkdirSync(logsDir);
    writeFileSync(
      path.join(logsDir, "server.log"),
      `${"bounded log line\n".repeat(5_000)}`,
      "utf8",
    );
    writeFileSync(path.join(logsDir, "server-error.log"), "test error\n", "utf8");
    const app = server({
      dataDir,
      launcherDataDir,
      store,
      engines,
      logger: false,
      buildVersion: "0.1.0-beta.engine-test",
      buildRevision: "engine-test-revision",
      releaseChannel: "beta",
      launcherSecurity: { controlToken: "launcher-secret" },
    });

    expect((await app.inject({
      method: "GET",
      url: "/api/launcher/status",
    })).statusCode).toBe(401);

    const status = await app.inject({
      method: "GET",
      url: "/api/launcher/status",
      headers: { authorization: "Bearer launcher-secret" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      version: "0.1.0-beta.engine-test",
      commit: "engine-test-revision",
      channel: "beta",
      activeRunCount: 0,
    });

    const log = await app.inject({
      method: "GET",
      url: "/api/launcher/logs?stream=server",
      headers: { authorization: "Bearer launcher-secret" },
    });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toMatchObject({
      stream: "server",
      truncated: true,
    });
    expect(log.json<{ returnedBytes: number }>().returnedBytes).toBeLessThanOrEqual(
      64 * 1_024,
    );
    expect((await app.inject({
      method: "GET",
      url: "/api/launcher/logs?stream=other",
      headers: { authorization: "Bearer launcher-secret" },
    })).statusCode).toBe(400);
  });

  it("reports engine authentication without invoking provider credentials", async () => {
    const broken = new BehavioralAdapter();
    Object.defineProperties(broken, {
      id: { value: "broken" },
      displayName: { value: "Broken adapter" },
    });
    const app = server({
      dataDir,
      store,
      logger: false,
      engines: [
        engines[0]!,
        {
          adapter: broken,
          authStatus: async () => {
            throw new Error("not logged in");
          },
        },
      ],
    });

    const response = await app.inject({ method: "GET", url: "/api/engines" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: "codex",
        authenticated: true,
        authDetail: "test subscription",
      }),
      expect.objectContaining({
        id: "broken",
        authenticated: false,
        authDetail: "not logged in",
      }),
    ]);
  });

  it("exports template packages and validates imports before creating Agents", async () => {
    const project = store.createProject({
      label: "Portable",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const source = store.createAgent(project.id, {
      title: "Source",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    store.setImportedHistory(source.id, "fixture", [{
      role: "user",
      text: "Private imported context",
      createdAt: "2026-07-26T12:00:00.000Z",
    }]);
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      artifactFilesystemCapabilityProbe: () => ({
        ok: true,
        detail: "test override",
      }),
    });

    const exported = await app.inject({
      method: "GET",
      url: `/api/agents/${source.id}/export?mode=template`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      schema: "ponderosa.agent-package.v1",
      mode: "template",
      kind: "agent",
      rootRef: source.id,
      agents: [{
        ref: source.id,
        title: "Source",
        engine: "codex",
      }],
    });
    expect(exported.json<{ agents: Array<Record<string, unknown>> }>().agents[0])
      .not.toHaveProperty("history");

    const portablePackage = {
      schema: "ponderosa.agent-package.v1",
      mode: "template",
      kind: "agent",
      exportedAt: "2026-07-26T12:00:00.000Z",
      sourceLabel: "Fixture / Imported",
      rootRef: "import-root",
      agents: [{
        ref: "import-root",
        title: "Imported",
        engine: "source-engine",
        managementPermissions: {
          allowAutomaticDescendantDeletion: false,
          allowAutomaticDescendantReorganization: false,
        },
      }],
    };
    const before = store.listAgents(project.id).length;
    const missingMapping = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/import-agents`,
      payload: {
        conversationId: project.lastConversationId,
        engineMapping: {},
        package: portablePackage,
      },
    });
    expect(missingMapping.statusCode).toBe(409);
    expect(missingMapping.json()).toEqual({
      error: "explicit engine mapping is required",
      requiredEngines: ["source-engine"],
    });
    expect(store.listAgents(project.id)).toHaveLength(before);

    const imported = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/import-agents`,
      payload: {
        conversationId: project.lastConversationId,
        engineMapping: { "source-engine": "codex" },
        package: portablePackage,
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const response = imported.json<{
      rootAgentId: string;
      agentIds: string[];
    }>();
    expect(response.agentIds).toEqual([response.rootAgentId]);
    expect(store.getAgent(response.rootAgentId)).toMatchObject({
      projectId: project.id,
      conversationId: project.lastConversationId,
      title: "Imported",
      activeEngine: "codex",
    });
  });

  it("publishes the Core attachment limits through both public routes", async () => {
    const app = server();
    const assetLimits = (await app.inject({
      method: "GET",
      url: "/api/asset-limits",
    })).json();
    const attachmentLimits = (await app.inject({
      method: "GET",
      url: "/api/attachment-limits",
    })).json();

    expect(assetLimits).toEqual(DEFAULT_ASSET_LIMITS);
    expect(attachmentLimits).toEqual({
      ...DEFAULT_ASSET_LIMITS,
      maxAttachmentsPerMessage: DEFAULT_ASSET_LIMITS.maxAssetsPerMessage,
    });
  });

  it("generates the current request-led title through the conversation route", async () => {
    const project = store.createProject({
      label: "Titles",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const conversationId = project.lastConversationId!;
    const appendMessage = (text: string, authorAgentId?: string) => {
      const eventId = randomUUID();
      store.appendCommunicationEvent({
        eventId,
        schemaVersion: 1,
        projectId: project.id,
        conversationId,
        sender: authorAgentId
          ? { kind: "agent", agentId: authorAgentId }
          : { kind: "user", userId: "local-operator" },
        intent: "broadcast",
        audience: { kind: "organization", organizationId: project.id },
        text,
        createdAt: new Date().toISOString(),
      });
      store.appendConversationMessage(
        conversationId,
        { text },
        authorAgentId,
        "main",
        undefined,
        undefined,
        eventId,
      );
    };
    appendMessage("Track down the flaky cache invalidation");
    appendMessage("I found the stale cursor path", "agent-title");
    const app = server();

    const generated = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/generate-title`,
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toEqual({
      title: "Track down the flaky cache",
      generated: true,
    });
    expect(store.getConversation(conversationId)?.title).toBe("Track down the flaky cache");
    expect((await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/generate-title`,
    })).json()).toEqual({
      title: "Track down the flaky cache",
      generated: false,
    });
  });

  it("projects canonical public messages without exposing execution fields", async () => {
    const project = store.createProject({ label: "Projection", hostPath: repoDir });
    const conversationId = project.lastConversationId!;
    const eventId = randomUUID();
    store.appendCommunicationEvent({
      eventId,
      schemaVersion: 1,
      projectId: project.id,
      conversationId,
      sender: { kind: "user", userId: "local-operator" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Canonical project update",
      createdAt: new Date().toISOString(),
    });
    store.appendConversationMessage(
      conversationId,
      { text: "Canonical project update" },
      undefined,
      "main",
      undefined,
      undefined,
      eventId,
    );
    const app = server();

    const detail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ messages: Array<Record<string, unknown>> }>().messages).toEqual([
      expect.objectContaining({
        text: "Canonical project update",
        communicationEventId: eventId,
      }),
    ]);
    expect(detail.body).not.toContain("toolCall");
    expect(detail.body).not.toContain("fileActivity");
  });

  it("presents Direct scope from stable audience identity and exposes no historical correction route", async () => {
    const project = store.createProject({ label: "Direct scope", hostPath: repoDir });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Spruce",
      engine: "codex",
      conversationId,
    });
    const eventId = randomUUID();
    store.appendCommunicationEvent({
      eventId,
      schemaVersion: 2,
      projectId: project.id,
      conversationId,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: {
        kind: "user_agent",
        userId: "local-operator",
        agentId: agent.id,
      },
      text: "Private request",
      createdAt: new Date().toISOString(),
    });
    store.appendConversationMessage(
      conversationId,
      { text: "Private request" },
      undefined,
      "main",
      undefined,
      undefined,
      eventId,
    );
    const app = server();

    const detail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ messages: Array<Record<string, unknown>> }>().messages).toEqual([
      expect.objectContaining({
        communicationEventId: eventId,
        communicationIntent: "user_dm",
        directMessageAgents: [{ id: agent.id, title: "Spruce" }],
      }),
    ]);

    const obsoleteEdit = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages/${eventId}/corrections`,
      payload: { text: "Replacement", idempotencyKey: randomUUID() },
    });
    expect(obsoleteEdit.statusCode).toBe(404);
  });

  it("does not duplicate an authored Agent mention in the All Messages projection", async () => {
    const project = store.createProject({ label: "Direct mention", hostPath: repoDir });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Crater Lake",
      engine: "codex",
      conversationId,
    });
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 },
    });

    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "#Crater-Lake hey", idempotencyKey: randomUUID() },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const communicationEventId = sent.json<{ communicationEventId: string }>().communicationEventId;

    const sentWithoutMention = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "hey again", idempotencyKey: randomUUID() },
    });
    expect(sentWithoutMention.statusCode, sentWithoutMention.body).toBe(202);
    const secondCommunicationEventId = sentWithoutMention
      .json<{ communicationEventId: string }>().communicationEventId;

    const allChat = await app.inject({ method: "GET", url: "/api/all-chat" });
    expect(allChat.statusCode, allChat.body).toBe(200);
    const messages = allChat.json<{ items: Array<{
      communicationEventId: string;
      text: string;
    }> }>().items;
    expect(messages.find((item) => item.communicationEventId === communicationEventId)?.text)
      .toBe("#Crater-Lake hey");
    expect(messages.find((item) => item.communicationEventId === secondCommunicationEventId)?.text)
      .toBe("#Crater-Lake hey again");
  });

  it("reconciles Direct recipient handles from send-time identity after rename or deletion", async () => {
    const project = store.createProject({ label: "Recovered Direct mentions", hostPath: repoDir });
    const conversationId = project.lastConversationId!;
    const renamedAgent = store.createAgent(project.id, {
      title: "Crater Lake",
      engine: "codex",
      conversationId,
    });
    const deletedAgent = store.createAgent(project.id, {
      title: "Timber",
      engine: "codex",
      conversationId,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    const seedInterruptedProjection = (input: {
      eventId: string;
      agentId: string;
      recipientLabel: string;
      text: string;
    }) => {
      const createdAt = new Date().toISOString();
      const communication: CommunicationEvent = {
        eventId: input.eventId,
        schemaVersion: 2,
        projectId: project.id,
        conversationId,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: {
          kind: "user_agent",
          userId: "local-operator",
          agentId: input.agentId,
        },
        text: input.text,
        identity: {
          senderLabel: "User",
          recipientLabels: { [input.agentId]: input.recipientLabel },
        },
        createdAt,
      };
      store.appendCommunicationEvent(communication);
      coordination.recordRuntimeCommunication({
        id: `dispatch:${input.eventId}:${input.agentId}`,
        projectId: project.id,
        sender: communication.sender,
        intent: communication.intent,
        audience: communication.audience,
        payload: {
          communication,
          dispatch: {
            text: input.text,
            communicationEventId: input.eventId,
            sourceConversationId: null,
            sourceChannel: null,
            shareWithOrganization: false,
            activeRunDelivery: "steer",
            attachments: [],
            model: null,
            effort: null,
            speed: null,
          },
        },
        now: createdAt,
      });
    };
    seedInterruptedProjection({
      eventId: "direct-before-rename",
      agentId: renamedAgent.id,
      recipientLabel: "Crater Lake",
      text: "#Crater-Lake hey",
    });
    seedInterruptedProjection({
      eventId: "direct-before-deletion",
      agentId: deletedAgent.id,
      recipientLabel: "Timber",
      text: "hello",
    });

    store.updateAgent(renamedAgent.id, { title: "Ridge" });
    store.deleteAgent(deletedAgent.id);

    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 },
    });
    await app.ready();
    const deadline = Date.now() + 2_000;
    while (
      !store.getProjectedConversationMessageById(conversationId, "main", "direct-before-deletion") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(store.getProjectedConversationMessageById(
      conversationId,
      "main",
      "direct-before-rename",
    )?.text).toBe("#Crater-Lake hey");
    expect(store.getProjectedConversationMessageById(
      conversationId,
      "main",
      "direct-before-deletion",
    )?.text).toBe("#Timber hello");
  });

  it("preserves multi-Agent Direct mention bindings after recipients are renamed or deleted", async () => {
    const project = store.createProject({ label: "Direct identity", hostPath: repoDir });
    const conversationId = project.lastConversationId!;
    const oak = store.createAgent(project.id, {
      title: "Oak",
      engine: "codex",
      conversationId,
    });
    const pine = store.createAgent(project.id, {
      title: "Pine",
      engine: "codex",
      conversationId,
    });
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 },
    });

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "(#Oak), (#Pine) Private update",
        recipients: [{ agentId: oak.id }, { agentId: pine.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(sent.statusCode).toBe(200);
    const messageId = sent.json<{ messageId: string }>().messageId;
    const message = store.getConversationMessages(conversationId, "main")
      .find((candidate) => candidate.id === messageId);
    expect(message?.communicationEventId).toBeTruthy();
    const eventId = message!.communicationEventId!;
    expect(store.getCommunicationEvent(project.id, eventId)?.identity).toEqual({
      senderLabel: "User",
      recipientLabels: { [oak.id]: "Oak", [pine.id]: "Pine" },
      conversationLabel: store.getConversation(conversationId)!.title,
    });

    store.updateAgent(oak.id, { title: "Redwood" });
    store.deleteAgent(pine.id);

    const expectedBindings = expect.arrayContaining([
      { handle: "Oak", agentId: oak.id },
      { handle: "Pine", agentId: pine.id },
    ]);
    const detail = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
    });
    expect(detail.statusCode).toBe(200);
    const detailMessage = detail.json<{ messages: Array<{
      communicationEventId?: string;
      directMessageAgents?: Array<{ id: string; title: string }>;
      agentMentions?: Array<{ handle: string; agentId: string }>;
    }> }>().messages.find((candidate) => candidate.communicationEventId === eventId);
    expect(detailMessage).toMatchObject({
      directMessageAgents: expect.arrayContaining([
        { id: oak.id, title: "Redwood" },
        { id: pine.id, title: "Pine" },
      ]),
      agentMentions: expectedBindings,
    });

    const allChat = await app.inject({ method: "GET", url: "/api/all-chat" });
    expect(allChat.statusCode).toBe(200);
    const allChatMessage = allChat.json<{ items: Array<{
      communicationEventId: string;
      directMessageAgents?: Array<{ id: string; title: string }>;
      agentMentions?: Array<{ handle: string; agentId: string }>;
    }> }>().items.find((candidate) => candidate.communicationEventId === eventId);
    expect(allChatMessage).toMatchObject({
      directMessageAgents: expect.arrayContaining([
        { id: oak.id, title: "Redwood" },
        { id: pine.id, title: "Pine" },
      ]),
      agentMentions: expectedBindings,
    });
  });

  it("projects Collaboration bindings into All Messages after rename and deletion", async () => {
    const project = store.createProject({ label: "Collaboration recipients", hostPath: repoDir });
    const conversationId = project.lastConversationId!;
    const oak = store.createAgent(project.id, {
      title: "Oak",
      engine: "codex",
      conversationId,
    });
    const pine = store.createAgent(project.id, {
      title: "Pine",
      engine: "codex",
      conversationId,
    });
    const fir = store.createAgent(project.id, {
      title: "Fir",
      engine: "codex",
      conversationId,
    });
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 60_000 },
    });
    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/collaboration/messages`,
      payload: {
        text: "The requested review is complete.",
        recipientAgentIds: [pine.id, fir.id],
        idempotencyKey: randomUUID(),
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const eventId = sent.json<{
      message: { communicationEventId?: string };
    }>().message.communicationEventId!;
    store.updateAgent(pine.id, { title: "Cedar" });
    store.deleteAgent(fir.id);
    const response = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/collaboration`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ messages: Array<Record<string, unknown>> }>().messages).toEqual([
      expect.objectContaining({
        communicationEventId: eventId,
        collaborationRecipients: expect.arrayContaining([
          { id: pine.id, title: "Cedar" },
          { id: fir.id, title: "Fir" },
        ]),
        agentMentions: expect.arrayContaining([
          { handle: "Pine", agentId: pine.id },
          { handle: "Fir", agentId: fir.id },
        ]),
      }),
    ]);

    const allChat = await app.inject({ method: "GET", url: "/api/all-chat" });
    expect(allChat.statusCode).toBe(200);
    const allChatMessage = allChat.json<{ items: Array<{
      communicationEventId: string;
      agentMentions?: Array<{ handle: string; agentId: string }>;
    }> }>().items.find(item => item.communicationEventId === eventId);
    expect(allChatMessage, allChat.body).toBeDefined();
    expect(allChatMessage?.agentMentions).toEqual(expect.arrayContaining([
      { handle: "Pine", agentId: pine.id },
      { handle: "Fir", agentId: fir.id },
    ]));
  });

  it("validates Agent preset CRUD through the public routes", async () => {
    const project = store.createProject({
      label: "Presets",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const app = server();

    expect((await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agent-presets`,
      payload: {
        name: "X",
        description: "Too short",
        guidance: "Use a careful and repeatable workflow.",
        engine: "codex",
      },
    })).json()).toEqual({ error: "name must be 2-60 characters" });

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agent-presets`,
      payload: {
        name: "Reviewer",
        description: "Review changes",
        guidance: "Review every change against the public behavior contract.",
        engine: "codex",
        model: "test-model",
        effort: "high",
      },
    });
    expect(created.statusCode).toBe(201);
    const preset = created.json<{ id: string }>();
    expect((await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-presets`,
    })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: preset.id, name: "Reviewer", enabled: true }),
    ]));

    const rejectedPatch = await app.inject({
      method: "PATCH",
      url: `/api/agent-presets/${preset.id}`,
      payload: { unexpected: true },
    });
    expect(rejectedPatch.statusCode).toBe(400);
    expect(rejectedPatch.json()).toEqual({ error: "unknown preset field" });
    expect((await app.inject({
      method: "DELETE",
      url: `/api/agent-presets/${preset.id}`,
    })).json()).toEqual({ deleted: true });
  });

  it("serves notification state and rejects push registration when host setup is absent", async () => {
    const workspace = new WorkspaceStore(dataDir);
    const notification = workspace.createNotification({
      kind: "operational",
      title: "Needs attention",
      body: "A provider needs operator attention.",
    });
    const app = server();

    expect((await app.inject({
      method: "GET",
      url: "/api/notifications",
    })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: notification.id, status: "open" }),
    ]));
    expect((await app.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/read`,
    })).json()).toEqual({ read: true });
    expect((await app.inject({
      method: "POST",
      url: `/api/notifications/${notification.id}/status`,
      payload: { status: "resolved" },
    })).json()).toEqual(expect.objectContaining({
      id: notification.id,
      status: "resolved",
    }));

    expect((await app.inject({
      method: "GET",
      url: "/api/push/status?deviceId=test-device",
    })).json()).toMatchObject({
      configured: false,
      configuration: "missing",
      deviceRegistered: false,
    });
    expect((await app.inject({
      method: "PUT",
      url: "/api/push/subscriptions/test-device",
      payload: {
        deviceId: "test-device",
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "public", auth: "auth" },
        updatedAt: "ignored",
      },
    })).statusCode).toBe(503);
  });

  it("fails artifact-dependent Agent creation closed when secure file authority is unavailable", async () => {
    const project = store.createProject({
      label: "Unsupported artifact filesystem",
      hostPath: repoDir,
      defaultEngine: "codex",
    });
    const app = server({
      dataDir,
      store,
      engines,
      logger: false,
      artifactFilesystemCapabilityProbe: () => ({
        ok: false,
        detail: "test secure artifact filesystem authority is unavailable",
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Blocked", engine: "codex" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: expect.stringContaining("test secure artifact filesystem authority is unavailable"),
    });
    expect(store.listAgents(project.id)).toHaveLength(0);
  });
});
