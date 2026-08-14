import type {
  Adapter,
  EngineAuthStatus,
  OpenRuntimeSessionOptions,
  RuntimeSession,
} from "@ponderosa/core";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { processBirthMarker, recoveredRuntimeProcessHandle } from "@ponderosa/engines";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./app.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function adapter(): Adapter {
  return {
    id: "codex",
    displayName: "Codex",
    listModels: () => [{ id: "test-model", label: "Test model" }],
    listEfforts: () => [],
  } as unknown as Adapter;
}

function namedAdapter(id: string, displayName: string): Adapter {
  return {
    ...adapter(),
    id,
    displayName,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function providerRunAdapter(input: {
  outcome: "success" | "authentication_failure" | "cancelled";
  started?: () => void;
  finished?: () => void;
  release?: Promise<void>;
}): Adapter {
  const stream = async function* () {
    try {
      input.started?.();
      if (input.release) await input.release;
      if (input.outcome === "authentication_failure") {
        yield { type: "reasoning" as const, delta: "provider accepted work" };
        yield { type: "error" as const, message: "authentication rejected by provider" };
        return;
      }
      yield { type: "turn_done" as const };
    } finally {
      input.finished?.();
    }
  };
  return {
    id: "codex",
    displayName: "Codex",
    trustedSystemPromptChannel: "developer",
    listModels: () => [{ id: "test-model", label: "Test model" }],
    listEfforts: () => [],
    seed: stream,
    continue: stream,
  };
}

function persistentProviderRunAdapter(input: {
  started: () => void;
  releaseTurn: Promise<void>;
  teardownStarted: () => void;
  releaseTeardown: Promise<void>;
  teardownFinished: () => void;
}): Adapter {
  return {
    id: "codex",
    displayName: "Codex",
    trustedSystemPromptChannel: "developer",
    listModels: () => [{ id: "test-model", label: "Test model" }],
    listEfforts: () => [],
    openSession: async (options: OpenRuntimeSessionOptions): Promise<RuntimeSession> => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const birthMarker = processBirthMarker(child.pid!);
      if (!birthMarker) throw new Error("test provider process lacks birth evidence");
      const authority = recoveredRuntimeProcessHandle({
        pid: child.pid!,
        pgid: child.pid!,
        birthMarker,
      }, {
        label: `reachability test provider ${options.agentId}`,
        termGraceMs: 500,
        killConfirmationMs: 500,
      });
      const session: RuntimeSession = {
        engineAgentId: `provider-${options.agentId}`,
        processIdentity: { pid: child.pid!, pgid: child.pid!, birthMarker },
        isAlive: () => authority.isAlive(),
        close: async () => {
          input.teardownStarted();
          await input.releaseTeardown;
          await authority.close();
          input.teardownFinished();
        },
        startTurn: async () => {
          input.started();
          return { turnId: `turn-${options.agentId}` };
        },
        steer: async () => ({ status: "unsupported", reason: "test runtime" }),
        interrupt: async () => undefined,
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, sessionId: `session-${options.agentId}` };
            await input.releaseTurn;
            yield { type: "turn_done" as const };
          },
        },
      };
      options.onRuntimeSpawned(session);
      return session;
    },
    async *seed() { yield { type: "turn_done" }; },
    async *continue() { yield { type: "turn_done" }; },
  };
}

async function providerRunFixture(input: {
  adapter: Adapter;
  availabilityProbe?: () => Promise<{ available: boolean; detail?: string }>;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-run-readiness-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const hostPath = path.join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(dataDir);
  const project = store.createProject({ label: "Provider Run", hostPath, defaultEngine: "codex" });
  const agent = store.createAgent(project.id, {
    title: "Provider Run Agent",
    engine: "codex",
    conversationId: project.lastConversationId,
  });
  const coordination = new CoordinationV3Store(store.sqlite);
  coordination.enqueueMessageActivation({
    projectId: project.id,
    agentId: agent.id,
    scopeKey: `conversation:${project.lastConversationId}`,
    messageId: `provider-run-${input.adapter.id}`,
    kind: "human",
    payload: { text: "exercise provider reachability" },
  });
  const app = createServer({
    dataDir,
    store,
    engines: [{
      adapter: input.adapter,
      authStatus: async () => ({ authenticated: true }),
      ...(input.availabilityProbe ? { availabilityProbe: input.availabilityProbe } : {}),
    }],
    communicationV3: { pollMs: 10 },
    logger: false,
  });
  await app.ready();
  return { agent, app, dataDir, project, store };
}

async function waitForRunStatus(
  store: AgentStore,
  status: "running" | "completed" | "failed" | "cancelled",
): Promise<{ id: string; status: string; fencingToken: number }> {
  let row: { id: string; status: string; fencingToken: number } | undefined;
  await vi.waitFor(() => {
    row = store.sqlite.prepare(`
      SELECT id, status, fencing_token AS fencingToken
      FROM scheduler_runs ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; status: string; fencingToken: number } | undefined;
    expect(row?.status).toBe(status);
  }, { timeout: 5_000, interval: 20 });
  return row!;
}

async function waitForAgentRunStatus(
  store: AgentStore,
  agentId: string,
  status: "failed" | "cancelled",
): Promise<void> {
  await vi.waitFor(() => {
    expect(store.getRuns(agentId).at(-1)?.status).toBe(status);
  }, { timeout: 5_000, interval: 20 });
}

async function reachability(app: Awaited<ReturnType<typeof providerRunFixture>>["app"]): Promise<string> {
  const response = await app.inject({ method: "GET", url: "/api/ready" });
  return response.json<{ runtimes: Array<{ reachability: string }> }>().runtimes[0]!.reachability;
}

async function fixture(authStatus: () => Promise<EngineAuthStatus>) {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-readiness-"));
  roots.push(root);
  const app = createServer({
    dataDir: path.join(root, "data"),
    engines: [{ adapter: adapter(), authStatus }],
  });
  await app.ready();
  return app;
}

describe("provider readiness truth", () => {
  it("records the first successful provider Run and preserves reachable evidence across restart", async () => {
    const started = deferred();
    const release = deferred();
    const fixture = await providerRunFixture({
      adapter: providerRunAdapter({
        outcome: "success",
        started: started.resolve,
        release: release.promise,
      }),
    });
    await started.promise;
    expect(await reachability(fixture.app)).toBe("unverified");
    release.resolve();
    await waitForRunStatus(fixture.store, "completed");
    expect(await reachability(fixture.app)).toBe("reachable");
    await fixture.app.close();

    const restarted = createServer({
      dataDir: fixture.dataDir,
      engines: [{
        adapter: adapter(),
        authStatus: async () => ({ authenticated: true }),
      }],
      logger: false,
    });
    await restarted.ready();
    expect(await restarted.inject({ method: "GET", url: "/api/ready" }))
      .toMatchObject({ statusCode: 200 });
    expect(await reachability(restarted)).toBe("reachable");
    await restarted.close();
  });

  it("records recovery from a denial and resolves its unavailable notification", async () => {
    const started = deferred();
    const release = deferred();
    const fixture = await providerRunFixture({
      adapter: providerRunAdapter({
        outcome: "success",
        started: started.resolve,
        release: release.promise,
      }),
      availabilityProbe: async () => ({
        available: false,
        detail: "provider rejected the access probe",
      }),
    });
    await started.promise;
    const denial = await fixture.app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    expect(denial.json()).toMatchObject({ reachability: "degraded" });
    expect((await fixture.app.inject({ method: "GET", url: "/api/notifications" })).json())
      .toEqual([expect.objectContaining({
        dedupeKey: "provider:codex:unavailable",
        status: "open",
      })]);

    release.resolve();
    await waitForRunStatus(fixture.store, "completed");
    expect(await reachability(fixture.app)).toBe("reachable");
    expect((await fixture.app.inject({ method: "GET", url: "/api/notifications" })).json())
      .toEqual([expect.objectContaining({
        dedupeKey: "provider:codex:unavailable",
        status: "resolved",
      })]);
    await fixture.app.close();
  });

  it("does not record positive reachability for failed or cancelled provider Runs", async () => {
    const failed = await providerRunFixture({
      adapter: providerRunAdapter({ outcome: "authentication_failure" }),
    });
    await waitForAgentRunStatus(failed.store, failed.agent.id, "failed");
    expect(await reachability(failed.app)).toBe("degraded");
    await failed.app.close();

    const started = deferred();
    const finished = deferred();
    const release = deferred();
    const cancelled = await providerRunFixture({
      adapter: providerRunAdapter({
        outcome: "cancelled",
        started: started.resolve,
        finished: finished.resolve,
        release: release.promise,
      }),
    });
    await started.promise;
    const running = await waitForRunStatus(cancelled.store, "running");
    const response = await cancelled.app.inject({
      method: "POST",
      url: `/api/agents/${cancelled.agent.id}/cancel`,
      payload: { targetRunId: running.id, idempotencyKey: "cancel-reachability-test" },
    });
    expect(response.statusCode).toBe(200);
    release.resolve();
    await waitForRunStatus(cancelled.store, "cancelled");
    await finished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await reachability(cancelled.app)).toBe("unverified");
    await cancelled.app.close();
  });

  it("does not record positive reachability when cancellation lands during awaited teardown", async () => {
    const started = deferred();
    const releaseTurn = deferred();
    const teardownStarted = deferred();
    const releaseTeardown = deferred();
    const teardownFinished = deferred();
    const fixture = await providerRunFixture({
      adapter: persistentProviderRunAdapter({
        started: started.resolve,
        releaseTurn: releaseTurn.promise,
        teardownStarted: teardownStarted.resolve,
        releaseTeardown: releaseTeardown.promise,
        teardownFinished: teardownFinished.resolve,
      }),
    });
    await started.promise;
    const running = await waitForRunStatus(fixture.store, "running");
    const policyUpdate = await fixture.app.inject({
      method: "PATCH",
      url: `/api/projects/${fixture.project.id}`,
      payload: { instructions: "refresh provider policy after this Run" },
    });
    expect(policyUpdate.statusCode).toBe(200);

    releaseTurn.resolve();
    await teardownStarted.promise;
    const cancellation = await fixture.app.inject({
      method: "POST",
      url: `/api/agents/${fixture.agent.id}/cancel`,
      payload: { targetRunId: running.id, idempotencyKey: "cancel-during-teardown" },
    });
    expect(cancellation.statusCode).toBe(200);
    const cancelledRun = await waitForRunStatus(fixture.store, "cancelled");
    expect(cancelledRun.fencingToken).toBeGreaterThan(running.fencingToken);

    releaseTeardown.resolve();
    await teardownFinished.promise;
    await vi.waitFor(async () => {
      expect(await reachability(fixture.app)).toBe("unverified");
    }, { timeout: 5_000, interval: 20 });
    const evidencePath = path.join(fixture.dataDir, "engine-availability.jsonl");
    expect(() => readFileSync(evidencePath, "utf8")).toThrow();
    await fixture.app.close();
  });

  it("keeps authenticated intake separate from unverified reachability", async () => {
    const app = await fixture(async () => ({ authenticated: true, detail: "signed in" }));
    const engines = await app.inject({ method: "GET", url: "/api/engines" });
    expect(engines.statusCode).toBe(200);
    expect(engines.json()).toEqual([expect.objectContaining({
      authentication: "authenticated",
      intakeReady: true,
      reachability: "unverified",
    })]);
    const rechecked = await app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    expect(rechecked.json()).toMatchObject({
      authentication: "authenticated",
      intakeReady: true,
      reachability: "unverified",
    });
    await app.close();
  });

  it("projects bounded provider-specific detail without exposing nested provider payloads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-detail-"));
    roots.push(root);
    const rawClaudeFailure = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      error: { message: `Claude subscription expired ${"x".repeat(600)}` },
      session_id: "private-claude-session",
    });
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [
        {
          adapter: namedAdapter("claude", "Claude"),
          authStatus: async () => ({ authenticated: true }),
          availabilityProbe: async () => ({ available: false, detail: rawClaudeFailure }),
        },
        {
          adapter: namedAdapter("codex", "Codex"),
          authStatus: async () => ({ authenticated: true }),
        },
      ],
      logger: false,
    });
    await app.ready();

    const recheck = await app.inject({ method: "POST", url: "/api/engines/claude/recheck" });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json()).toMatchObject({
      id: "claude",
      displayName: "Claude",
      intakeReady: false,
      reachability: "degraded",
    });
    expect(recheck.json().availabilityDetail).toMatch(/^Claude subscription expired/u);
    expect(recheck.json().availabilityDetail.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(recheck.json())).not.toContain("private-claude-session");

    const engines = (await app.inject({ method: "GET", url: "/api/engines" })).json();
    expect(engines).toEqual([
      expect.objectContaining({ id: "claude", intakeReady: false, reachability: "degraded" }),
      expect.objectContaining({ id: "codex", intakeReady: true }),
    ]);
    const notifications = (await app.inject({ method: "GET", url: "/api/notifications" })).json();
    expect(JSON.stringify(notifications)).not.toContain("private-claude-session");
    await app.close();
  });

  it("reports a bounded authentication timeout as checking, not signed out", async () => {
    const app = await fixture(() => new Promise((resolve) => {
      setTimeout(() => resolve({ authenticated: true, detail: "signed in" }), 1_000);
    }));
    const readiness = await app.inject({ method: "GET", url: "/api/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      canAcceptWork: false,
      runtimes: [{
        authentication: "checking",
        intakeReady: false,
        reachability: "checking",
        detail: "runtime check exceeded readiness budget",
      }],
    });
    await app.close();
  });

  it("does not convert successful authentication recheck into provider reachability", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-recheck-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const store = new AgentStore(dataDir);
    const evidencePath = path.join(dataDir, "engine-availability.jsonl");
    writeFileSync(evidencePath, `${JSON.stringify({
      engineId: "codex",
      available: false,
      detail: "provider rejected prior work",
      source: "provider_run",
      observedAt: "2026-08-14T00:00:00.000Z",
    })}\n`);
    const app = createServer({
      dataDir,
      store,
      engines: [{ adapter: adapter(), authStatus: async () => ({ authenticated: true, detail: "signed in" }) }],
      logger: false,
    });
    await app.ready();
    const response = await app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authentication: "authenticated",
      intakeReady: false,
      reachability: "degraded",
    });
    expect(readFileSync(evidencePath, "utf8").trim().split("\n")).toHaveLength(1);
    await app.close();
  });

  it("uses the same authenticated intake authority for readiness and active Run leasing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-admission-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: "Admission", hostPath, defaultEngine: "codex" });
    const agent = store.createAgent(project.id, {
      title: "Admission Agent",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.enqueueMessageActivation({
      projectId: project.id,
      agentId: agent.id,
      scopeKey: `conversation:${project.lastConversationId}`,
      messageId: "auth-admission",
      kind: "human",
      payload: { text: "held until authenticated" },
    });
    let authenticated = false;
    const app = createServer({
      dataDir,
      store,
      engines: [{ adapter: adapter(), authStatus: async () => ({ authenticated }) }],
      communicationV3: { pollMs: 10 },
      logger: false,
    });
    await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get() as { count: number }).count).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(503);

    authenticated = true;
    const recheck = await app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json()).toMatchObject({
      authentication: "authenticated",
      intakeReady: true,
      reachability: "unverified",
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = (store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get() as { count: number }).count;
      if (count > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get() as { count: number }).count).toBeGreaterThan(0);
    await app.close();
  });

  it("never leases queued work while running the bounded shutdown recovery verifier", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-shutdown-recovery-admission-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: "Recovery", hostPath, defaultEngine: "codex" });
    const agent = store.createAgent(project.id, {
      title: "Recovery Agent",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    new CoordinationV3Store(store.sqlite).enqueueMessageActivation({
      projectId: project.id,
      agentId: agent.id,
      scopeKey: `conversation:${project.lastConversationId}`,
      messageId: "recovery-must-not-lease",
      kind: "human",
      payload: { text: "remain queued" },
    });
    const app = createServer({
      dataDir,
      store,
      startupMode: "shutdown_recovery",
      engines: [{ adapter: adapter(), authStatus: async () => ({ authenticated: true }) }],
      logger: false,
    });
    await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get() as { count: number }).count).toBe(0);
    await app.close();
  });
});
