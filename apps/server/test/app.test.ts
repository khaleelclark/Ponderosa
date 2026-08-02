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
  ContinueOptions,
  SeedOptions,
} from "@ponderosa/core";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import { ClaudeAdapter } from "@ponderosa/engines";
import { secureFileAuthoritySupported } from "@ponderosa/native-host";
import { createServer, type EngineRegistration } from "../src/app.js";

class BehavioralAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Behavioral adapter";
  seedCalls = 0;

  listModels() {
    return [{ id: "test-model", label: "Test model" }];
  }

  listEfforts() {
    return [{ id: "high", label: "High" }];
  }

  async *seed(_options: SeedOptions): AsyncIterable<AgentEvent> {
    this.seedCalls += 1;
    yield { type: "turn_done" };
  }

  async *continue(_options: ContinueOptions): AsyncIterable<AgentEvent> {
    yield { type: "turn_done" };
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
