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
import { publicProviderAvailabilityDetail } from "./provider-availability-detail.js";

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

async function readSseUntil(
  response: Awaited<ReturnType<typeof fetch>>,
  expected: string,
): Promise<string> {
  if (!response.body) throw new Error("SSE response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    while (!body.includes(expected)) {
      let timeout: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`SSE did not emit ${expected}`)), 5_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (chunk.done) throw new Error(`SSE ended before emitting ${expected}`);
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function providerRunAdapter(input: {
  outcome: "success" | "authentication_failure" | "cancelled";
  errorMessage?: string;
  thrownFailure?: unknown;
  started?: () => void;
  finished?: () => void;
  release?: Promise<void>;
}): Adapter {
  const stream = async function* () {
    try {
      input.started?.();
      if (input.release) await input.release;
      if (input.thrownFailure !== undefined) throw input.thrownFailure;
      if (input.outcome === "authentication_failure") {
        yield { type: "reasoning" as const, delta: "provider accepted work" };
        yield {
          type: "error" as const,
          code: "authentication_failed" as const,
          message: input.errorMessage ?? "authentication rejected by provider",
        };
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
  managerContext?: "managed_child";
}) {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-run-readiness-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const hostPath = path.join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(dataDir);
  const project = store.createProject({ label: "Provider Run", hostPath, defaultEngine: "codex" });
  const manager = input.managerContext ? store.createAgent(project.id, {
    title: "Provider Run Manager",
    engine: "codex",
    conversationId: project.lastConversationId,
  }) : undefined;
  const agent = store.createAgent(project.id, {
    title: "Provider Run Agent",
    engine: "codex",
    conversationId: project.lastConversationId,
    ...(manager ? { managerAgentId: manager.id } : {}),
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
  return { agent, app, coordination, dataDir, manager, project, store };
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

  it("rebuilds restart notifications from the persisted structured provider category", async () => {
    const restricted = "RESTART_NOTIFICATION_RAW_MARKER_83aa rate limit reached access_token=private-restart-token";
    const failed = await providerRunFixture({
      adapter: providerRunAdapter({
        outcome: "authentication_failure",
        errorMessage: restricted,
      }),
    });
    await waitForAgentRunStatus(failed.store, failed.agent.id, "failed");
    expect((await failed.app.inject({ method: "GET", url: "/api/notifications" })).json())
      .toEqual([expect.objectContaining({
        body: expect.stringContaining("Provider authentication was rejected."),
      })]);
    await failed.app.close();

    const persistedEvidence = readFileSync(
      path.join(failed.dataDir, "engine-availability.jsonl"),
      "utf8",
    );
    expect(persistedEvidence).toContain('"failureCategory":"authentication"');
    expect(persistedEvidence).toContain("RESTART_NOTIFICATION_RAW_MARKER_83aa");

    const restarted = createServer({
      dataDir: failed.dataDir,
      engines: [{
        adapter: adapter(),
        authStatus: async () => ({ authenticated: true }),
      }],
      logger: false,
    });
    await restarted.ready();
    const notifications = await restarted.inject({ method: "GET", url: "/api/notifications" });
    expect(notifications.json()).toEqual([expect.objectContaining({
      body: expect.stringContaining("Provider authentication was rejected."),
    })]);
    expect(notifications.body).not.toMatch(
      /RESTART_NOTIFICATION_RAW_MARKER_83aa|private-restart-token|access_token|rate limit reached|Provider execution failed/u,
    );
    await restarted.close();
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
      error: JSON.stringify({
        message: `Claude subscription expired ${"x".repeat(600)}`,
        session_id: "private-nested-claude-session",
        access_token: "private-nested-access-token",
      }),
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
    expect(recheck.json().availabilityDetail).toBe("Provider execution failed.");
    expect(recheck.json().availabilityDetail.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(recheck.json())).not.toMatch(
      /session_id|access_token|private-(?:claude|nested)/u,
    );

    const engines = (await app.inject({ method: "GET", url: "/api/engines" })).json();
    expect(engines).toEqual([
      expect.objectContaining({ id: "claude", intakeReady: false, reachability: "degraded" }),
      expect.objectContaining({ id: "codex", intakeReady: true }),
    ]);
    const notifications = (await app.inject({ method: "GET", url: "/api/notifications" })).json();
    expect(JSON.stringify(notifications)).not.toMatch(
      /session_id|access_token|private-(?:claude|nested)/u,
    );
    await app.close();
  });

  it("fails closed for secret-bearing, malformed, and over-deep provider detail", () => {
    const secretEnvelope = JSON.stringify({
      error: JSON.stringify({
        message: JSON.stringify({ session_id: "private-session", access_token: "private-token" }),
      }),
    });
    expect(publicProviderAvailabilityDetail(secretEnvelope)).toBe("Provider execution failed.");
    expect(publicProviderAvailabilityDetail('{"message":"access_token: private-token","error":')).toBe("Provider execution failed.");

    let deep: unknown = { message: "must-not-escape-depth-limit" };
    for (let index = 0; index < 8; index += 1) deep = { error: JSON.stringify(deep) };
    expect(publicProviderAvailabilityDetail(JSON.stringify(deep))).toBe("Provider execution failed.");
    expect(publicProviderAvailabilityDetail("x".repeat(64 * 1024 + 1))).toBe("Provider execution failed.");
  });

  it("rejects credential paths, tokens, key material, encoded JSON, and obfuscated secrets", () => {
    const adversarial = [
      "failed reading /home/phoenix/.config/gh/hosts.yml",
      "failed reading /tmp",
      String.raw`failed reading C:\Users\Patrick\.aws\credentials`,
      String.raw`failed reading C:\auth.json`,
      String.raw`failed reading .aws\credentials`,
      String.raw`failed reading \u002fhome\u002fphoenix\u002f.codex\u002fauth.json`,
      "password=hunter2",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "oauth callback code=private-code",
      "-----BEGIN PRIVATE KEY----- private-key-material",
      "eyJzZXNzaW9uX2lkIjoicHJpdmF0ZSJ9",
      "Zk9xR1p4dHFzUDBTQnNLWkQ5Q3h5ZkF0RmhjWmZ2",
      "access\u200b_token=private-token",
      String.raw`pa\u0073sword=hunter2`,
      String.raw`password%3Dhunter2`,
      String.raw`password\u003dhunter2`,
      "pass\u2063word=hunter2",
      "pass\u061cword=hunter2",
      "pass\ufe0fword=hunter2",
      "pass\u{e0100}word=hunter2",
      "pa\u0301ssword=hunter2",
      "paѕѕԝord=hunter2",
      "passwօrd=hunter2",
      "ƿassword=hunter2",
      String.raw`pa\\\\u0073sword\\u003dhunter2`,
      "pass%E2%81%A3word=hunter2",
      "pa%25252573sword%2525253Dhunter2",
      "pa%2525u0073sword%25253Dhunter2",
      "SECRET_KEY=hunter2",
      "/root",
      "/etc/shadow",
      "/auth.json",
      "$HOME/.aws/credentials",
      "${HOME}/.codex/auth.json",
      "W3sicGFzc3dvcmQiOiJ4In1d",
    ];
    for (const detail of adversarial) {
      const publicDetail = publicProviderAvailabilityDetail(detail);
      expect(publicDetail, detail).toBe("Provider execution failed.");
      expect(publicDetail, detail).not.toContain(detail);
    }
    expect(publicProviderAvailabilityDetail("connection reset by peer")).toBe("Provider is temporarily unavailable.");
  });

  it("sanitizes throwing auth status across recheck and readiness endpoints", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-auth-exception-"));
    roots.push(root);
    const restricted = String.raw`authentication probe failed session_id=private-session access_token=private-token at C:\Users\Patrick\.codex\auth.json and /home/phoenix/.config/gh/hosts.yml`;
    const usageAdapter: Adapter = {
      ...adapter(),
      readProviderUsage: async () => ({
        provider: "codex",
        windows: [],
        source: "provider-rpc",
        fetchedAt: new Date().toISOString(),
      }),
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{
        adapter: usageAdapter,
        authStatus: async () => { throw new Error(restricted); },
      }],
      logger: false,
    });
    await app.ready();

    const responses = [
      await app.inject({ method: "POST", url: "/api/engines/codex/recheck" }),
      await app.inject({ method: "GET", url: "/api/engines" }),
      await app.inject({ method: "GET", url: "/api/ready" }),
      await app.inject({ method: "GET", url: "/api/diagnostics/ready" }),
      await app.inject({ method: "GET", url: "/api/provider-usage" }),
      await app.inject({ method: "POST", url: "/api/provider-usage/codex/refresh" }),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 503, 503, 200, 200]);
    for (const response of responses) {
      expect(response.body).toContain("runtime authentication could not be checked");
      expect(response.body).not.toMatch(/private-session|private-token|Users|phoenix|hosts\.yml|auth\.json/u);
    }
    await app.close();
  });

  it("returns a canonical 503 when engine metadata throws without exposing provider exception text", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-engine-metadata-exception-"));
    roots.push(root);
    const restricted = [
      "AUTHENTICATION_FAILURE",
      "Basic cHJpdmF0ZS11c2VyOnByaXZhdGUtcGFzc3dvcmQ=",
      String.raw`pa\u0073sword=hunter2`,
      "access_token=private-engine-token",
      String.raw`C:\Users\Patrick\.codex\auth.json`,
      "/home/phoenix/.config/gh/hosts.yml",
    ].join(" ");
    const throwingAdapter: Adapter = {
      ...adapter(),
      listModels: () => { throw new Error(restricted); },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{
        adapter: throwingAdapter,
        authStatus: async () => ({ authenticated: true }),
      }],
      logger: false,
    });
    await app.ready();

    const responses = [
      await app.inject({ method: "GET", url: "/api/engines" }),
      await app.inject({ method: "POST", url: "/api/engines/codex/recheck" }),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([503, 503]);
    for (const response of responses) {
      expect(response.json()).toEqual({
        error: "Provider execution failed.",
        category: "provider_error",
        remediation: "Review the restricted server logs, then retry the provider operation.",
      });
      expect(response.body).not.toMatch(
        /AUTHENTICATION_FAILURE|Basic|private-|hunter2|password|access_token|Users|phoenix|auth\.json|hosts\.yml/u,
      );
    }
    const notifications = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.body).not.toMatch(
      /AUTHENTICATION_FAILURE|Basic|private-|hunter2|password|access_token|Users|phoenix|auth\.json|hosts\.yml/u,
    );
    await app.close();
  });

  it("uses a useful closed fallback for unclassified engine metadata exceptions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-engine-metadata-fallback-"));
    roots.push(root);
    const throwingAdapter: Adapter = {
      ...adapter(),
      listModels: () => { throw new Error("private-semantic-marker-742"); },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{ adapter: throwingAdapter }],
      logger: false,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/engines" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Provider execution failed.",
      category: "provider_error",
      remediation: "Review the restricted server logs, then retry the provider operation.",
    });
    expect(response.body).not.toContain("private-semantic-marker-742");
    await app.close();
  });

  it("contains asynchronous provider capability exceptions at the public 503 boundary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-capability-exception-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(path.join(root, "data"));
    const project = store.createProject({
      label: "Capability Exception",
      hostPath,
      defaultEngine: "codex",
    });
    const restricted = String.raw`CAPABILITY_SEMANTIC_MARKER access_token=private-capability-token at /root/.codex/auth.json`;
    const throwingAdapter: Adapter = {
      ...adapter(),
      capabilities: async () => { throw new Error(restricted); },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      store,
      engines: [{ adapter: throwingAdapter }],
      logger: false,
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Provider execution failed.",
      category: "provider_error",
      remediation: "Review the restricted server logs, then retry the provider operation.",
    });
    expect(response.body).not.toMatch(
      /CAPABILITY_SEMANTIC_MARKER|private-capability-token|access_token|root|auth\.json/u,
    );
    await app.close();
  });

  it("fails closed for circular capability success data over inject, a listening socket, and restart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-capability-circular-success-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const dataDir = path.join(root, "data");
    const marker = "CAPABILITY_CIRCULAR_SUCCESS_MARKER_40c9 access_token=private-capability-success";
    const circularCapabilities = (): unknown => {
      const result = {
        steering: false,
        persistentSessions: false,
        commands: [],
        mcpServers: [],
        composerCapabilities: [],
      } as Record<string, unknown>;
      result.self = { marker, result };
      return result;
    };
    const capabilityAdapter: Adapter = {
      ...adapter(),
      capabilities: async () => circularCapabilities() as never,
    };
    const store = new AgentStore(dataDir);
    const project = store.createProject({
      label: "Circular Capability",
      hostPath,
      defaultEngine: "codex",
    });
    const app = createServer({ dataDir, store, engines: [{ adapter: capabilityAdapter }], logger: false });
    await app.ready();
    const injectResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    });
    expect(injectResponse.statusCode).toBe(503);
    expect(injectResponse.json()).toEqual({
      error: "Provider execution failed.",
      category: "provider_error",
      remediation: "Review the restricted server logs, then retry the provider operation.",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socketResponse = await fetch(
      `${address}/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    );
    expect(socketResponse.status).toBe(503);
    const socketBody = await socketResponse.text();
    expect(JSON.parse(socketBody)).toEqual(injectResponse.json());
    expect(`${injectResponse.body}${socketBody}`).not.toMatch(
      /CAPABILITY_CIRCULAR_SUCCESS_MARKER_40c9|private-capability-success|access_token|self|circular/iu,
    );
    await app.close();

    const reopenedStore = new AgentStore(dataDir);
    const restarted = createServer({
      dataDir,
      store: reopenedStore,
      engines: [{ adapter: capabilityAdapter }],
      logger: false,
    });
    await restarted.ready();
    const afterRestart = await restarted.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    });
    expect(afterRestart.statusCode).toBe(503);
    expect(afterRestart.body).not.toMatch(
      /CAPABILITY_CIRCULAR_SUCCESS_MARKER_40c9|private-capability-success|access_token|self|circular/iu,
    );
    await restarted.close();
  });

  it("does not replace the last closed capability cache entry with a malformed refresh", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-capability-malformed-refresh-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const dataDir = path.join(root, "data");
    const store = new AgentStore(dataDir);
    const project = store.createProject({
      label: "Capability Cache",
      hostPath,
      defaultEngine: "codex",
    });
    const marker = "CAPABILITY_REFRESH_CACHE_MARKER_f31b secret_key=private-cache-secret";
    let reads = 0;
    const capabilityAdapter: Adapter = {
      ...adapter(),
      capabilities: async () => {
        reads += 1;
        const result = {
          steering: true,
          persistentSessions: true,
          catalogVersion: "safe-catalog",
          commands: [],
          mcpServers: [],
          composerCapabilities: [],
        } as Record<string, unknown>;
        if (reads > 1) result.self = { marker, result };
        return result as never;
      },
    };
    const app = createServer({ dataDir, store, engines: [{ adapter: capabilityAdapter }], logger: false });
    await app.ready();
    const first = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual([expect.objectContaining({
      engineId: "codex",
      discovered: true,
      catalogVersion: "safe-catalog",
    })]);
    const malformed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    });
    expect(malformed.statusCode).toBe(503);
    const cached = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex`,
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json()).toEqual([expect.objectContaining({
      engineId: "codex",
      discovered: true,
      catalogVersion: "safe-catalog",
    })]);
    expect(`${malformed.body}${cached.body}`).not.toMatch(
      /CAPABILITY_REFRESH_CACHE_MARKER_f31b|private-cache-secret|secret_key|self/u,
    );
    await app.close();
  });

  it("rejects a schema-valid cumulative capability catalog before inject or socket serialization", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-capability-budget-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const marker = "CAPABILITY_CUMULATIVE_BUDGET_MARKER_7c42";
    const tiers = Array.from({ length: 64 }, (_, index) => ({
      id: `tier-${index}`,
      label: `Tier ${index}`,
      description: `${marker}-${"x".repeat(8_000)}`,
    }));
    const capabilityAdapter: Adapter = {
      ...adapter(),
      capabilities: async () => ({
        steering: false,
        persistentSessions: false,
        modelCatalog: {
          models: Array.from({ length: 500 }, (_, index) => ({
            id: `model-${index}`,
            label: `Model ${index}`,
            kind: "exact",
            source: "provider-probe",
            serviceTiers: tiers,
          })),
          cliVersion: "1.0.0",
          configurationKey: "budget-attack",
        },
        commands: [],
        mcpServers: [],
        composerCapabilities: [],
      } as never),
    };
    const store = new AgentStore(path.join(root, "data"));
    const project = store.createProject({
      label: "Capability Budget",
      hostPath,
      defaultEngine: "codex",
    });
    const app = createServer({
      dataDir: path.join(root, "data"),
      store,
      engines: [{ adapter: capabilityAdapter }],
      logger: false,
    });
    await app.ready();
    const url = `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`;
    const injected = await app.inject({ method: "GET", url });
    expect(injected.statusCode).toBe(503);
    expect(injected.json()).toEqual({
      error: "Provider execution failed.",
      category: "provider_error",
      remediation: "Review the restricted server logs, then retry the provider operation.",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await fetch(`${address}${url}`);
    const socketBody = await socket.text();
    expect(socket.status).toBe(503);
    expect(JSON.parse(socketBody)).toEqual(injected.json());
    expect(`${injected.body}${socketBody}`).not.toContain(marker);
    await app.close();
  });

  it("contains throwing exception getters across availability, validation, and capability APIs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-exception-getters-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(path.join(root, "data"));
    const project = store.createProject({
      label: "Provider Exception Getters",
      hostPath,
      defaultEngine: "codex",
    });
    const markers = {
      availability: "AVAILABILITY_THROWING_MESSAGE_MARKER_0c71",
      validation: "VALIDATION_THROWING_MESSAGE_MARKER_5fd2",
      capability: "CAPABILITY_THROWING_MESSAGE_MARKER_83ae",
    };
    const errorLike = (marker: string): object => {
      const value = Object.create(Error.prototype) as object;
      Object.defineProperty(value, "message", {
        get: () => { throw new Error(marker); },
      });
      return value;
    };
    const hostileAdapter: Adapter = {
      ...adapter(),
      validateModel: async () => { throw errorLike(markers.validation); },
      capabilities: async () => { throw errorLike(markers.capability); },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      store,
      engines: [{
        adapter: hostileAdapter,
        authStatus: async () => ({ authenticated: true }),
        availabilityProbe: async () => { throw errorLike(markers.availability); },
      }],
    });
    await app.ready();

    const recheck = await app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    const validation = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/engine-models/codex/validate`,
      payload: { modelId: "test-model" },
    });
    const capabilities = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/engine-capabilities?engineId=codex&refresh=true`,
    });

    expect(recheck.statusCode).toBe(200);
    expect(recheck.json()).toMatchObject({
      availabilityCategory: "unavailable",
      availabilityDetail: "Provider is temporarily unavailable.",
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toEqual({
      valid: false,
      errorCode: "provider_error",
      error: "Provider execution failed.",
    });
    expect(capabilities.statusCode).toBe(503);
    expect(capabilities.json()).toEqual({
      error: "Provider execution failed.",
      category: "provider_error",
      remediation: "Review the restricted server logs, then retry the provider operation.",
    });
    for (const body of [recheck.body, validation.body, capabilities.body]) {
      expect(body).not.toMatch(
        /AVAILABILITY_THROWING_MESSAGE_MARKER_0c71|VALIDATION_THROWING_MESSAGE_MARKER_5fd2|CAPABILITY_THROWING_MESSAGE_MARKER_83ae/u,
      );
    }
    await app.close();
  });

  it("sanitizes resolved invalid model-validation results with structured-code precedence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-model-validation-boundary-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(path.join(root, "data"));
    const project = store.createProject({
      label: "Model Validation Boundary",
      hostPath,
      defaultEngine: "codex",
    });
    const restricted = "MODEL_VALIDATION_RAW_MARKER_91d4 access_token=private-validation-token";
    const hostileCode = "MODEL_VALIDATION_CODE_MARKER_4ac7";
    const validationAdapter: Adapter = {
      ...adapter(),
      validateModel: async (_cwd, modelId) => {
        if (modelId === "auth-model") return {
          valid: false,
          errorCode: "authentication",
          error: `rate limit reached ${restricted}`,
        };
        if (modelId === "hostile-code-model") return {
          valid: false,
          errorCode: hostileCode,
          error: restricted,
        } as never;
        return {
          valid: false,
          errorCode: "provider_error",
          error: restricted,
        };
      },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      store,
      engines: [{ adapter: validationAdapter }],
      logger: false,
    });
    await app.ready();

    const unknown = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/engine-models/codex/validate`,
      payload: { modelId: "unknown-model" },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({
      valid: false,
      errorCode: "provider_error",
      error: "Provider execution failed.",
    });

    const authentication = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/engine-models/codex/validate`,
      payload: { modelId: "auth-model" },
    });
    expect(authentication.statusCode).toBe(200);
    expect(authentication.json()).toEqual({
      valid: false,
      errorCode: "authentication",
      error: "Provider authentication was rejected.",
    });
    const hostile = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/engine-models/codex/validate`,
      payload: { modelId: "hostile-code-model" },
    });
    expect(hostile.statusCode).toBe(200);
    expect(hostile.json()).toEqual({
      valid: false,
      errorCode: "provider_error",
      error: "Provider execution failed.",
    });
    expect(`${unknown.body}\n${authentication.body}\n${hostile.body}`).not.toMatch(
      /MODEL_VALIDATION_RAW_MARKER_91d4|MODEL_VALIDATION_CODE_MARKER_4ac7|private-validation-token|access_token|rate limit reached/u,
    );
    await app.close();
  });

  it("returns only structured static failures for rejected provider commands", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-command-boundary-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    const project = store.createProject({
      label: "Provider Command Boundary",
      hostPath,
      defaultEngine: "codex",
    });
    const agent = store.createAgent(project.id, {
      title: "Provider Command Agent",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const restricted = "PROVIDER_COMMAND_RAW_MARKER_d03f rate limit reached access_token=private-command-token";
    const commandAdapter: Adapter = {
      ...adapter(),
      openSession: async () => {
        throw Object.assign(new Error(restricted), {
          code: "authentication_failed",
          catalogVersion: `private-catalog-${restricted}`,
        });
      },
    };
    const app = createServer({
      dataDir,
      store,
      engines: [{ adapter: commandAdapter }],
      logger: false,
    });
    await app.ready();

    const responses = [
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/provider-commands`,
        payload: { engineId: "codex", name: "status" },
      }),
      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/provider-commands`,
        payload: { name: "status" },
      }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "Provider authentication was rejected.",
        category: "authentication",
        remediation: "Check the provider subscription and sign-in, then retry.",
      });
      expect(response.body).not.toMatch(
        /PROVIDER_COMMAND_RAW_MARKER_d03f|private-command-token|private-catalog|access_token|rate limit reached/u,
      );
    }
    await app.close();
  });

  it("contains throwing provider-command error getters and proxies at both APIs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-command-hostile-error-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    const project = store.createProject({
      label: "Provider Command Hostile Error",
      hostPath,
      defaultEngine: "codex",
    });
    const agent = store.createAgent(project.id, {
      title: "Provider Command Hostile Agent",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const getterMarker = "PROVIDER_COMMAND_GETTER_MARKER_69c4";
    const proxyMarker = "PROVIDER_COMMAND_PROXY_MARKER_b108";
    const getterError = Object.create(Error.prototype) as Record<string, unknown>;
    for (const property of ["message", "code", "errorCode", "category", "failureCategory"]) {
      Object.defineProperty(getterError, property, {
        get: () => { throw new Error(`${getterMarker}:${property}`); },
      });
    }
    const proxyError = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_target, property) => { throw new Error(`${proxyMarker}:${String(property)}`); },
    });
    let invocation = 0;
    const commandAdapter: Adapter = {
      ...adapter(),
      openSession: async () => {
        invocation += 1;
        throw invocation === 1 ? getterError : proxyError;
      },
    };
    const app = createServer({
      dataDir,
      store,
      engines: [{ adapter: commandAdapter }],
      logger: false,
    });
    await app.ready();

    const responses = [
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/provider-commands`,
        payload: { engineId: "codex", name: "status" },
      }),
      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/provider-commands`,
        payload: { name: "status" },
      }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "Provider execution failed.",
        category: "unknown",
        remediation: "Review the restricted server logs, then retry the provider operation.",
      });
      expect(response.body).not.toMatch(
        /PROVIDER_COMMAND_GETTER_MARKER_69c4|PROVIDER_COMMAND_PROXY_MARKER_b108/u,
      );
    }
    await app.close();
  });

  it("sanitizes asynchronous provider-usage failures before later cache projections", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-usage-cache-error-"));
    roots.push(root);
    const restricted = String.raw`usage failed pa\\u0073sword=hunter2 access_token=private-usage-token at $HOME/.codex/auth.json`;
    const usageAdapter: Adapter = {
      ...adapter(),
      readProviderUsage: async () => {
        await Promise.resolve();
        throw new Error(restricted);
      },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{
        adapter: usageAdapter,
        authStatus: async () => ({ authenticated: true, detail: "signed in" }),
      }],
      logger: false,
    });
    await app.ready();

    const refresh = await app.inject({
      method: "POST",
      url: "/api/provider-usage/codex/refresh",
    });
    expect(refresh.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const later = await app.inject({ method: "GET", url: "/api/provider-usage" });
      expect(later.statusCode).toBe(200);
      expect(later.json().providers).toEqual([expect.objectContaining({
        provider: "codex",
        refreshing: false,
        error: "Provider execution failed.",
      })]);
      expect(later.body).not.toMatch(/hunter2|private-usage-token|password|access_token|HOME|auth\.json/u);
    });
    await app.close();
  });

  it("fails closed for circular provider-usage success over inject and a listening socket", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-usage-circular-success-"));
    roots.push(root);
    const marker = "USAGE_CIRCULAR_API_MARKER_77a0 refresh_token=private-usage-success";
    const circularUsage = {
      provider: "codex",
      windows: [],
      source: "provider-rpc",
      fetchedAt: new Date().toISOString(),
    } as Record<string, unknown>;
    circularUsage.self = { marker, circularUsage };
    const usageAdapter: Adapter = {
      ...adapter(),
      readProviderUsage: async () => circularUsage as never,
    };
    const dataDir = path.join(root, "data");
    const app = createServer({
      dataDir,
      engines: [{
        adapter: usageAdapter,
        authStatus: async () => ({ authenticated: true, detail: "signed in" }),
      }],
      logger: false,
    });
    const unhandled: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const onUncaught = (error: unknown): void => { uncaught.push(error); };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    try {
      await app.ready();
      const refresh = await app.inject({
        method: "POST",
        url: "/api/provider-usage/codex/refresh",
      });
      expect(refresh.statusCode).toBe(200);
      await vi.waitFor(async () => {
        const state = await app.inject({ method: "GET", url: "/api/provider-usage" });
        expect(state.json().providers).toEqual([expect.objectContaining({
          provider: "codex",
          refreshing: false,
          error: "Provider execution failed.",
        })]);
        expect(state.body).not.toMatch(
          /USAGE_CIRCULAR_API_MARKER_77a0|private-usage-success|refresh_token|self|circular/iu,
        );
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const socketResponse = await fetch(`${address}/api/provider-usage`);
      expect(socketResponse.status).toBe(200);
      const socketBody = await socketResponse.text();
      expect(JSON.parse(socketBody).providers).toEqual([expect.objectContaining({
        provider: "codex",
        refreshing: false,
        error: "Provider execution failed.",
      })]);
      expect(socketBody).not.toMatch(
        /USAGE_CIRCULAR_API_MARKER_77a0|private-usage-success|refresh_token|self|circular/iu,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUncaught);
      await app.close();
    }
  });

  it("fails closed for cumulative usage data without caching or process-level rejection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-usage-budget-"));
    roots.push(root);
    const marker = "USAGE_CUMULATIVE_BUDGET_MARKER_a913";
    const usageAdapter: Adapter = {
      ...adapter(),
      readProviderUsage: async () => ({
        provider: "codex",
        windows: Array.from({ length: 100 }, (_, index) => ({
          id: `窗口-${index}-${"界".repeat(500)}`,
          label: `${marker}-${index}-${"量".repeat(950)}`,
          usedPercent: 20,
          resetsAt: `重置-${index}-${"时".repeat(500)}`,
        })),
        source: "provider-rpc",
        fetchedAt: new Date().toISOString(),
      } as never),
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{
        adapter: usageAdapter,
        authStatus: async () => ({ authenticated: true, detail: "signed in" }),
      }],
      logger: false,
    });
    const unhandled: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const onUncaught = (error: unknown): void => { uncaught.push(error); };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    try {
      await app.ready();
      expect((await app.inject({ method: "POST", url: "/api/provider-usage/codex/refresh" })).statusCode)
        .toBe(200);
      await vi.waitFor(async () => {
        const state = await app.inject({ method: "GET", url: "/api/provider-usage" });
        expect(state.json().providers).toEqual([expect.objectContaining({
          provider: "codex",
          refreshing: false,
          error: "Provider execution failed.",
        })]);
        expect(state.body).not.toContain(marker);
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const socketBody = await (await fetch(`${address}/api/provider-usage`)).text();
      expect(socketBody).not.toContain(marker);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUncaught);
      await app.close();
    }
  });

  it("contains hostile initial and refresh usage rejections without an unhandled rejection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-usage-hostile-exceptions-"));
    roots.push(root);
    const initialMarker = "USAGE_INITIAL_THROWING_GETTER_MARKER_76a1";
    const refreshMarker = "USAGE_REFRESH_THROWING_PROXY_MARKER_cb42";
    const initialError = Object.create(Error.prototype) as object;
    Object.defineProperty(initialError, "message", {
      get: () => { throw new Error(initialMarker); },
    });
    const refreshError = new Proxy(Object.create(null) as object, {
      get: () => { throw new Error(refreshMarker); },
      getOwnPropertyDescriptor: () => { throw new Error(`${refreshMarker}:descriptor`); },
      getPrototypeOf: () => { throw new Error(`${refreshMarker}:prototype`); },
    });
    let claudeReads = 0;
    const codexUsage: Adapter = {
      ...namedAdapter("codex", "Codex"),
      readProviderUsage: async () => { throw initialError; },
    };
    const claudeUsage: Adapter = {
      ...namedAdapter("claude", "Claude"),
      readProviderUsage: async () => {
        claudeReads += 1;
        if (claudeReads > 1) throw refreshError;
        return {
          provider: "claude",
          windows: [],
          source: "provider-rpc",
          fetchedAt: new Date().toISOString(),
        };
      },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [codexUsage, claudeUsage].map((usageAdapter) => ({
        adapter: usageAdapter,
        authStatus: async () => ({ authenticated: true, detail: "signed in" }),
      })),
      logger: false,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await app.ready();
      const initial = await app.inject({
        method: "GET",
        url: "/api/provider-usage?refresh=stale",
      });
      expect(initial.statusCode).toBe(200);
      await vi.waitFor(async () => {
        const state = await app.inject({ method: "GET", url: "/api/provider-usage" });
        expect(state.json().providers).toEqual(expect.arrayContaining([
          expect.objectContaining({
            provider: "codex",
            refreshing: false,
            error: "Provider execution failed.",
          }),
          expect.objectContaining({
            provider: "claude",
            refreshing: false,
            reading: expect.objectContaining({ provider: "claude" }),
          }),
        ]));
        expect(state.body).not.toMatch(
          /USAGE_INITIAL_THROWING_GETTER_MARKER_76a1|USAGE_REFRESH_THROWING_PROXY_MARKER_cb42/u,
        );
      });

      const refresh = await app.inject({
        method: "POST",
        url: "/api/provider-usage/claude/refresh",
      });
      expect(refresh.statusCode).toBe(200);
      await vi.waitFor(async () => {
        const state = await app.inject({ method: "GET", url: "/api/provider-usage" });
        expect(state.json().providers).toEqual(expect.arrayContaining([
          expect.objectContaining({
            provider: "claude",
            refreshing: false,
            error: "Provider execution failed.",
            reading: expect.objectContaining({ provider: "claude", stale: true }),
          }),
        ]));
        expect(state.body).not.toMatch(
          /USAGE_INITIAL_THROWING_GETTER_MARKER_76a1|USAGE_REFRESH_THROWING_PROXY_MARKER_cb42/u,
        );
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await app.close();
    }
  });

  it("sanitizes provider-usage process cleanup failures before later cache projections", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-usage-cleanup-error-"));
    roots.push(root);
    const restricted = String.raw`cleanup failed pa\\u0073sword=hunter2 secret_key=x at /root/.aws/credentials`;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const birthMarker = processBirthMarker(child.pid!);
    if (!birthMarker) throw new Error("usage cleanup test process birth marker unavailable");
    child.unref();
    const runtimeHandle = recoveredRuntimeProcessHandle({
      pid: child.pid!,
      pgid: child.pid!,
      birthMarker,
    }, {
      label: "provider usage cleanup regression",
      termGraceMs: 500,
      killConfirmationMs: 500,
    });
    let closeAttempts = 0;
    const usageAdapter: Adapter = {
      ...adapter(),
      readProviderUsage: async (options) => {
        options.onRuntimeSpawned({
          processIdentity: runtimeHandle.processIdentity,
          isAlive: () => runtimeHandle.isAlive(),
          close: async () => {
            closeAttempts += 1;
            if (closeAttempts === 1) throw new Error(restricted);
            await runtimeHandle.close();
          },
        });
        return {
          provider: "codex",
          windows: [],
          source: "provider-rpc",
          fetchedAt: new Date().toISOString(),
        };
      },
    };
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{
        adapter: usageAdapter,
        authStatus: async () => ({ authenticated: true, detail: "signed in" }),
      }],
      logger: false,
    });
    await app.ready();

    const refresh = await app.inject({
      method: "POST",
      url: "/api/provider-usage/codex/refresh",
    });
    expect(refresh.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const later = await app.inject({ method: "GET", url: "/api/provider-usage" });
      expect(later.statusCode).toBe(200);
      expect(later.json().providers).toEqual([expect.objectContaining({
        provider: "codex",
        refreshing: false,
        error: "Provider execution failed.",
      })]);
      expect(later.body).not.toMatch(/hunter2|password|secret_key|root|credentials/u);
    });
    await app.close();
    if (runtimeHandle.isAlive()) await runtimeHandle.close();
  });

  it("fails closed across recheck, engine, and notification projections for adversarial detail", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-adversarial-detail-"));
    roots.push(root);
    const restricted = [
      "authentication rejected",
      String.raw`pa\u0073sword=hunter2`,
      "pass\u2063word=hunter2",
      "password%3Dhunter2",
      "SECRET_KEY=hunter2",
      "W3sicGFzc3dvcmQiOiJ4In1d",
      "$HOME/.aws/credentials",
      "/auth.json",
      String.raw`C:\Users\Patrick\.aws\credentials`,
    ].join(" ");
    const app = createServer({
      dataDir: path.join(root, "data"),
      engines: [{
        adapter: adapter(),
        authStatus: async () => ({ authenticated: true }),
        availabilityProbe: async () => ({ available: false, detail: restricted }),
      }],
      logger: false,
    });
    await app.ready();

    const recheck = await app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    const engines = await app.inject({ method: "GET", url: "/api/engines" });
    const notifications = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(recheck.statusCode).toBe(200);
    for (const body of [recheck.body, engines.body, notifications.body]) {
      expect(body).not.toMatch(/hunter2|SECRET_KEY|W3sicGF|HOME|auth\.json|Users|credentials/u);
    }
    expect(recheck.json().availabilityDetail).toBe("Provider execution failed.");
    expect(notifications.json()).toEqual([expect.objectContaining({
      body: expect.stringContaining("Provider execution failed."),
    })]);
    await app.close();
  });

  it("normalizes hostile availability categories before persistence and public projection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-hostile-availability-category-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const categoryMarker = "AVAILABILITY_CATEGORY_MARKER_1f6b";
    const detailMarker = "AVAILABILITY_RESTRICTED_DETAIL_MARKER_8d2e access_token=private-availability-token";
    const hostileAdapter: Adapter = {
      ...adapter(),
    };
    const app = createServer({
      dataDir,
      engines: [{
        adapter: hostileAdapter,
        authStatus: async () => ({ authenticated: true }),
        availabilityProbe: async () => ({
          available: false,
          failureCategory: categoryMarker,
          detail: detailMarker,
        } as never),
      }],
      logger: false,
    });
    await app.ready();

    const recheck = await app.inject({ method: "POST", url: "/api/engines/codex/recheck" });
    const engines = await app.inject({ method: "GET", url: "/api/engines" });
    const notifications = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(recheck.json()).toMatchObject({
      availabilityCategory: "unknown",
      availabilityDetail: "Provider execution failed.",
    });
    expect(notifications.json()).toEqual([expect.objectContaining({
      body: expect.stringContaining("Provider execution failed."),
    })]);
    for (const body of [recheck.body, engines.body, notifications.body]) {
      expect(body).not.toMatch(
        /AVAILABILITY_CATEGORY_MARKER_1f6b|AVAILABILITY_RESTRICTED_DETAIL_MARKER_8d2e|private-availability-token|access_token/u,
      );
    }

    const evidence = readFileSync(path.join(dataDir, "engine-availability.jsonl"), "utf8");
    expect(evidence).toContain('"failureCategory":"unknown"');
    expect(evidence).toContain("AVAILABILITY_RESTRICTED_DETAIL_MARKER_8d2e");
    expect(evidence).not.toContain(categoryMarker);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const replayResponse = await fetch(`${address}/api/workspace/stream?lastEventId=0`);
    const replayBody = await readSseUntil(replayResponse, "notification_changed");
    expect(replayBody).not.toMatch(
      /AVAILABILITY_CATEGORY_MARKER_1f6b|AVAILABILITY_RESTRICTED_DETAIL_MARKER_8d2e|private-availability-token|access_token/u,
    );
    await app.close();

    const restarted = createServer({
      dataDir,
      engines: [{
        adapter: adapter(),
        authStatus: async () => ({ authenticated: true }),
      }],
      logger: false,
    });
    await restarted.ready();
    const restartedBodies = [
      (await restarted.inject({ method: "GET", url: "/api/engines" })).body,
      (await restarted.inject({ method: "GET", url: "/api/notifications" })).body,
    ];
    for (const body of restartedBodies) {
      expect(body).not.toMatch(
        /AVAILABILITY_CATEGORY_MARKER_1f6b|AVAILABILITY_RESTRICTED_DETAIL_MARKER_8d2e|private-availability-token|access_token/u,
      );
    }
    await restarted.close();
  });

  it("sanitizes the immediate live provider Run failure notification", async () => {
    const liveFailure = JSON.stringify({
      type: "result",
      error: JSON.stringify({
        message: "authentication rejected by provider",
        session_id: "private-live-session",
        refresh_token: "private-live-token",
      }),
      session_id: "private-outer-live-session",
    });
    const failed = await providerRunFixture({
      adapter: providerRunAdapter({ outcome: "authentication_failure", errorMessage: liveFailure }),
    });
    await waitForAgentRunStatus(failed.store, failed.agent.id, "failed");

    await vi.waitFor(async () => {
      const notifications = (await failed.app.inject({ method: "GET", url: "/api/notifications" })).json();
      expect(notifications).toEqual([expect.objectContaining({
        dedupeKey: "provider:codex:unavailable",
        body: expect.stringContaining("Provider authentication was rejected."),
      })]);
      expect(JSON.stringify(notifications)).not.toMatch(
        /session_id|refresh_token|private-(?:live|outer-live)/u,
      );
    });
    const engines = (await failed.app.inject({ method: "GET", url: "/api/engines" })).json();
    expect(engines).toEqual([expect.objectContaining({
      availabilityDetail: "Provider authentication was rejected.",
      availabilityCategory: "authentication",
      intakeReady: false,
      reachability: "degraded",
    })]);
    expect(JSON.stringify(engines)).not.toMatch(
      /session_id|refresh_token|private-(?:live|outer-live)/u,
    );
    await failed.app.close();
  });

  it.each(["trapped", "revoked"])(
    "terminalizes a scheduler Run exactly once when the provider generator throws a %s exception value",
    async (kind) => {
      const marker = `PROVIDER_RUN_TERMINAL_TRAP_MARKER_${kind}_61e4`;
      let thrownFailure: unknown;
      if (kind === "revoked") {
        const revocable = Proxy.revocable(Object.create(Error.prototype) as object, {});
        revocable.revoke();
        thrownFailure = revocable.proxy;
      } else {
        const target = Object.create(Error.prototype) as Record<PropertyKey, unknown>;
        for (const property of ["message", "code", "name", "stack"] as const) {
          Object.defineProperty(target, property, {
            get: () => { throw new Error(`${marker}:${property}`); },
          });
        }
        Object.defineProperty(target, Symbol.hasInstance, {
          get: () => { throw new Error(`${marker}:hasInstance`); },
        });
        Object.defineProperty(target, Symbol.toPrimitive, {
          get: () => { throw new Error(`${marker}:toPrimitive`); },
        });
        thrownFailure = new Proxy(target, {
          get: () => { throw new Error(`${marker}:get`); },
          getOwnPropertyDescriptor: () => { throw new Error(`${marker}:descriptor`); },
          getPrototypeOf: () => { throw new Error(`${marker}:prototype`); },
          ownKeys: () => { throw new Error(`${marker}:ownKeys`); },
        });
      }
      const unhandled: unknown[] = [];
      const uncaught: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      const onUncaught = (error: unknown): void => { uncaught.push(error); };
      process.on("unhandledRejection", onUnhandled);
      process.on("uncaughtException", onUncaught);
      const failed = await providerRunFixture({
        adapter: providerRunAdapter({ outcome: "success", thrownFailure }),
      });
      try {
        const run = await waitForRunStatus(failed.store, "failed");
        await waitForAgentRunStatus(failed.store, failed.agent.id, "failed");
        await new Promise<void>((resolve) => setImmediate(resolve));
        const durable = failed.store.sqlite.prepare(`
          SELECT status, terminal_at, provider_failure_json
          FROM scheduler_runs WHERE id = ?
        `).get(run.id) as {
          status: string;
          terminal_at: string | null;
          provider_failure_json: string | null;
        };
        expect(durable.status).toBe("failed");
        expect(durable.terminal_at).toBeTruthy();
        expect(JSON.parse(durable.provider_failure_json ?? "null")).toMatchObject({
          category: "unknown",
          message: "Provider execution failed.",
        });
        expect(failed.store.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM scheduler_runs
          WHERE id = ? AND status = 'failed' AND provider_failure_json IS NOT NULL
        `).get(run.id)).toEqual({ count: 1 });
        const failedLifecycles = failed.store.readEvents(failed.agent.id).filter(({ event }) =>
          event.type === "agent_lifecycle" && event.status === "failed");
        expect(failedLifecycles).toHaveLength(1);
        const publicBodies = [
          (await failed.app.inject({ method: "GET", url: `/api/agents/${failed.agent.id}/history/activity` })).body,
          (await failed.app.inject({ method: "GET", url: "/api/notifications" })).body,
        ];
        expect(publicBodies.join("\n")).not.toContain(marker);
        expect(unhandled).toEqual([]);
        expect(uncaught).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        process.off("uncaughtException", onUncaught);
        await failed.app.close();
      }
    },
    15_000,
  );

  it("persists and streams only the finite provider failure event for live and replay delivery", async () => {
    const started = deferred();
    const release = deferred();
    const restricted = "AGENT_SSE_RAW_MARKER_5f12 access_token=private-sse-token at /root/.codex/auth.json";
    const failed = await providerRunFixture({
      adapter: providerRunAdapter({
        outcome: "authentication_failure",
        errorMessage: restricted,
        started: started.resolve,
        release: release.promise,
      }),
    });
    await started.promise;
    const address = await failed.app.listen({ host: "127.0.0.1", port: 0 });
    const liveCursor = failed.store.lastSeqOf(failed.agent.id);
    const liveResponse = await fetch(
      `${address}/api/agents/${failed.agent.id}/stream?lastEventId=${liveCursor}`,
    );
    expect(liveResponse.status).toBe(200);

    release.resolve();
    const liveBody = await readSseUntil(liveResponse, '"type":"error"');
    expect(liveBody).toContain('"message":"Provider authentication was rejected."');
    expect(liveBody).toContain('"category":"authentication"');
    expect(liveBody).toContain(
      '"remediation":"Check the provider subscription and sign-in, then retry."',
    );
    expect(liveBody).not.toMatch(/AGENT_SSE_RAW_MARKER_5f12|private-sse-token|access_token|root|auth\.json/u);

    await waitForAgentRunStatus(failed.store, failed.agent.id, "failed");
    const error = failed.store.readEvents(failed.agent.id).find((stored) => stored.event.type === "error");
    expect(error?.event).toEqual({
      type: "error",
      code: "authentication_failed",
      message: "Provider authentication was rejected.",
      category: "authentication",
      remediation: "Check the provider subscription and sign-in, then retry.",
    });
    const eventLog = readFileSync(path.join(
      failed.dataDir,
      "projects",
      failed.project.id,
      "agents",
      failed.agent.id,
      "events.jsonl",
    ), "utf8");
    const eventRows = failed.store.sqlite.prepare(`
      SELECT payload_json FROM events WHERE agent_id = ? AND type = 'error'
    `).all(failed.agent.id) as Array<{ payload_json: string }>;
    const activity = await failed.app.inject({
      method: "GET",
      url: `/api/agents/${failed.agent.id}/history/activity`,
    });
    for (const publicEvidence of [eventLog, JSON.stringify(eventRows), activity.body]) {
      expect(publicEvidence).toContain("Provider authentication was rejected.");
      expect(publicEvidence).not.toMatch(
        /AGENT_SSE_RAW_MARKER_5f12|private-sse-token|access_token|root|auth\.json/u,
      );
    }

    const audit = failed.store.sqlite.prepare(`
      SELECT provider_failure_json FROM scheduler_runs
      WHERE provider_failure_json IS NOT NULL ORDER BY rowid DESC LIMIT 1
    `).get() as { provider_failure_json: string };
    expect(audit.provider_failure_json).toContain(restricted);

    const replayResponse = await fetch(
      `${address}/api/agents/${failed.agent.id}/stream?lastEventId=${Math.max(0, error!.seq - 1)}`,
    );
    expect(replayResponse.status).toBe(200);
    const replayBody = await readSseUntil(replayResponse, '"type":"error"');
    expect(replayBody).toContain('"message":"Provider authentication was rejected."');
    expect(replayBody).toContain('"category":"authentication"');
    expect(replayBody).toContain('"replayed":true');
    expect(replayBody).not.toMatch(/AGENT_SSE_RAW_MARKER_5f12|private-sse-token|access_token|root|auth\.json/u);
    await failed.app.close();
  }, 15_000);

  it("keeps managed-child failure context public while retaining raw Run audit evidence", async () => {
    const restricted = String.raw`AUTHENTICATION_FAILURE authentication rejected Basic cHJpdmF0ZS11c2VyOnByaXZhdGUtcGFzc3dvcmQ= session_id=private-managed-session access_token=private-managed-token pa\u0073sword=hunter2 SECRET_KEY=x W3sicGFzc3dvcmQiOiJ4In1d at /root/.aws/credentials`;
    const failed = await providerRunFixture({
      adapter: providerRunAdapter({ outcome: "authentication_failure", errorMessage: restricted }),
      managerContext: "managed_child",
    });
    await waitForAgentRunStatus(failed.store, failed.agent.id, "failed");

    await vi.waitFor(() => {
      const communications = failed.store.sqlite.prepare(`
        SELECT payload_json FROM runtime_communications
        WHERE intent = 'managed_child_failure'
      `).all() as Array<{ payload_json: string }>;
      expect(communications).toHaveLength(1);
      expect(communications[0]!.payload_json).toContain("Provider authentication was rejected.");
      expect(communications[0]!.payload_json).not.toMatch(/private-managed|hunter2|SECRET_KEY|W3sicGF|root|credentials/u);
      const activation = failed.store.sqlite.prepare(`
        SELECT payload_json FROM agent_activations
        WHERE kind = 'managed_child_failure'
      `).get() as { payload_json: string } | undefined;
      expect(activation?.payload_json).toContain("Provider authentication was rejected.");
      expect(activation?.payload_json).not.toMatch(/private-managed|hunter2|SECRET_KEY|W3sicGF|root|credentials/u);
    });
    let audit: { id: string; provider_failure_json: string } | undefined;
    await vi.waitFor(() => {
      audit = failed.store.sqlite.prepare(`
        SELECT id, provider_failure_json FROM scheduler_runs
        WHERE provider_failure_json IS NOT NULL ORDER BY rowid DESC LIMIT 1
      `).get() as { id: string; provider_failure_json: string } | undefined;
      expect(audit).toBeTruthy();
    });
    expect(audit!.provider_failure_json).toContain("private-managed-session");
    const rawAuditMessage = JSON.parse(audit!.provider_failure_json).message as string;
    expect(rawAuditMessage).toContain(String.raw`pa\u0073sword=hunter2`);
    expect(rawAuditMessage).toContain("SECRET_KEY=x");
    expect(rawAuditMessage).toContain("W3sicGFzc3dvcmQiOiJ4In1d");
    expect(rawAuditMessage).toContain("/root/.aws/credentials");
    expect(rawAuditMessage).toContain("Basic cHJpdmF0ZS");
    expect(rawAuditMessage).toContain("access_token=private-managed-token");

    const publicDetails = await failed.app.inject({
      method: "GET",
      url: `/api/projects/${failed.project.id}/agent-work/items/run/${audit!.id}`
        + `?conversationId=${failed.project.lastConversationId}`,
    });
    expect(publicDetails.statusCode).toBe(200);
    expect(publicDetails.json().details).toEqual(expect.arrayContaining([
      { label: "Provider failure summary", value: "Provider authentication was rejected." },
      {
        label: "Operator action",
        value: "Review provider access and retry the affected work when the provider is available.",
      },
    ]));
    expect(publicDetails.body).not.toMatch(
      /AUTHENTICATION_FAILURE|Basic|private-|hunter2|password|access_token|SECRET_KEY|W3sicGF|root|credentials/u,
    );
    await failed.app.close();
  });

  it("keeps correlated Request failure reasons public and raw evidence audit-only", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-request-failure-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(path.join(root, "data"));
    const project = store.createProject({ label: "Provider Request", hostPath, defaultEngine: "codex" });
    const requester = store.createAgent(project.id, {
      title: "Requester",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const recipient = store.createAgent(project.id, {
      title: "Recipient",
      engine: "codex",
      conversationId: project.lastConversationId,
      managerAgentId: requester.id,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    const requestId = coordination.coordinate({
      projectId: project.id,
      conversationId: project.lastConversationId,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "provider-failure-request",
      requests: [{
        recipientAgentId: recipient.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "exercise terminal provider failure" },
      }],
    }).requestIds[0]!;
    const lease = coordination.leaseNextRun({ workerId: "provider-failure-worker" });
    if (!lease) throw new Error("provider failure Request was not leased");
    const restricted = String.raw`authentication rejected pa\u0073sword=hunter2 refresh_token=private-request-token at $HOME/.aws/credentials`;
    expect(coordination.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "provider-failure-worker",
      sameRunResumable: false,
      retryable: false,
      terminalOutcome: "permanent_failure",
      failureKind: "authentication",
      error: restricted,
      failureDetail: {
        phase: "prompt_submission",
        promptInjectionState: "not_injected",
        message: restricted,
      },
    })).toBe("terminal");
    expect(coordination.getRequest(requestId)?.state).toBe("failed");

    const activationErrors = store.sqlite.prepare(`
      SELECT last_delivery_error FROM agent_activations
    `).all() as Array<{ last_delivery_error: string | null }>;
    const requestUpdates = store.sqlite.prepare(`
      SELECT payload_json FROM coordination_request_updates WHERE request_id = ?
    `).all(requestId) as Array<{ payload_json: string }>;
    expect(JSON.stringify(activationErrors)).not.toMatch(/hunter2|pa\\u0073sword|private-request|HOME|credentials/u);
    expect(JSON.stringify(requestUpdates)).not.toMatch(/hunter2|pa\\u0073sword|private-request|HOME|credentials/u);
    expect(JSON.stringify({ activationErrors, requestUpdates })).toContain("Provider authentication was rejected.");

    const publicContext = JSON.stringify({
      activations: activationErrors,
      communications: store.sqlite.prepare(`
        SELECT payload_json FROM runtime_communications
      `).all(),
      updates: requestUpdates,
    });
    expect(publicContext).not.toMatch(/hunter2|pa\\u0073sword|private-request-token|HOME|credentials/u);
    expect(publicContext).toContain("Provider authentication was rejected.");
    const audit = store.sqlite.prepare(`
      SELECT provider_failure_json FROM scheduler_runs WHERE id = ?
    `).get(lease.runId) as { provider_failure_json: string };
    expect(audit.provider_failure_json).toContain("private-request-token");
    expect(JSON.parse(audit.provider_failure_json).message).toContain(String.raw`pa\u0073sword=hunter2`);
    expect(JSON.parse(audit.provider_failure_json).message).toContain("$HOME/.aws/credentials");
  });

  it("migrates historical provider Request updates before lifecycle, Agent Work, notification, and SSE reads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-provider-request-migration-api-"));
    roots.push(root);
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const dataDir = path.join(root, "data");
    const originalStore = new AgentStore(dataDir);
    const project = originalStore.createProject({
      label: "Provider Request Migration",
      hostPath,
      defaultEngine: "codex",
    });
    const requester = originalStore.createAgent(project.id, {
      title: "Requester",
      engine: "codex",
      conversationId: project.lastConversationId,
    });
    const recipient = originalStore.createAgent(project.id, {
      title: "Recipient",
      engine: "codex",
      conversationId: project.lastConversationId,
      managerAgentId: requester.id,
    });
    const coordination = new CoordinationV3Store(originalStore.sqlite);
    const requestId = coordination.coordinate({
      projectId: project.id,
      conversationId: project.lastConversationId,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "historical-provider-request",
      requests: [{
        recipientAgentId: recipient.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "exercise historical provider failure" },
      }],
    }).requestIds[0]!;
    const lease = coordination.leaseNextRun({ workerId: "historical-provider-worker" });
    if (!lease) throw new Error("historical provider Request was not leased");
    expect(coordination.failRun({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      workerId: "historical-provider-worker",
      sameRunResumable: false,
      retryable: false,
      terminalOutcome: "permanent_failure",
      failureKind: "authentication",
      error: "authentication rejected",
      failureDetail: {
        phase: "prompt_submission",
        promptInjectionState: "not_injected",
        message: "authentication rejected",
      },
    })).toBe("terminal");
    const update = originalStore.sqlite.prepare(`
      SELECT id FROM coordination_request_updates WHERE request_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(requestId) as { id: string };
    const outcome = originalStore.sqlite.prepare(`
      SELECT id FROM agent_activations
      WHERE kind = 'coordination_outcome'
        AND json_extract(payload_json, '$.updateId') = ?
      LIMIT 1
    `).get(update.id) as { id: string };
    const marker = "HISTORICAL_REQUEST_UPDATE_MARKER_9ca2 access_token=private-request-migration";
    originalStore.sqlite.prepare(`
      UPDATE coordination_request_updates
      SET payload_json = ?, provider_failure_category = NULL
      WHERE id = ?
    `).run(JSON.stringify({
      activationId: lease.activationIds[0],
      activationOutcome: "permanent_failure",
      reason: marker,
    }), update.id);
    originalStore.sqlite.prepare(`
      UPDATE agent_activations SET payload_json = ? WHERE id = ?
    `).run(JSON.stringify({
      requestId,
      state: "failed",
      updateId: update.id,
      update: { reason: marker },
    }), outcome.id);
    originalStore.sqlite.prepare(`
      DELETE FROM _schema_version
      WHERE name IN (
        '0009_public_provider_request_updates.ts',
        '0010_provider_activation_execution_payloads.ts'
      )
    `).run();
    originalStore.close();

    const reopenedStore = new AgentStore(dataDir);
    const migratedRows = JSON.stringify({
      update: reopenedStore.sqlite.prepare(`
        SELECT payload_json, provider_failure_category
        FROM coordination_request_updates WHERE id = ?
      `).get(update.id),
      outcome: reopenedStore.sqlite.prepare(`
        SELECT payload_json FROM agent_activations WHERE id = ?
      `).get(outcome.id),
    });
    expect(migratedRows).toContain("Provider authentication was rejected.");
    expect(migratedRows).not.toMatch(
      /HISTORICAL_REQUEST_UPDATE_MARKER_9ca2|private-request-migration|access_token/u,
    );
    const restrictedAudit = reopenedStore.sqlite.prepare(`
      SELECT provider_failure_json FROM scheduler_runs WHERE id = ?
    `).get(lease.runId) as { provider_failure_json: string };
    expect(restrictedAudit.provider_failure_json).toContain("authentication rejected");

    const capturedProviderInputs: string[] = [];
    const baseRunAdapter = providerRunAdapter({ outcome: "success" });
    const captureAdapter: Adapter = {
      ...baseRunAdapter,
      seed: (options) => {
        capturedProviderInputs.push(options.prompt);
        return baseRunAdapter.seed(options);
      },
    };
    const app = createServer({
      dataDir,
      store: reopenedStore,
      engines: [{
        adapter: captureAdapter,
        authStatus: async () => ({ authenticated: true }),
      }],
      communicationV3: { pollMs: 10 },
      logger: false,
    });
    await app.ready();
    await vi.waitFor(() => expect(capturedProviderInputs).toHaveLength(1), {
      timeout: 5_000,
      interval: 20,
    });
    const exactProviderInput = (reopenedStore.sqlite.prepare(`
      SELECT provider_prompt FROM provider_inputs ORDER BY created_at DESC, execution_id DESC LIMIT 1
    `).get() as { provider_prompt: string }).provider_prompt;
    for (const providerInput of [...capturedProviderInputs, exactProviderInput]) {
      expect(providerInput).toContain("Provider authentication was rejected.");
      expect(providerInput).not.toMatch(
        /HISTORICAL_REQUEST_UPDATE_MARKER_9ca2|private-request-migration|access_token/u,
      );
    }
    const lifecycle = new CoordinationV3Store(reopenedStore.sqlite).requestLifecycleDetails({
      projectId: project.id,
      conversationId: project.lastConversationId,
      recordId: requestId,
    });
    const agentWork = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work/items/request/${requestId}`
        + `?conversationId=${project.lastConversationId}`,
    });
    const outcomeWork = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/agent-work/items/activation/${outcome.id}`
        + `?conversationId=${project.lastConversationId}`,
    });
    const notifications = await app.inject({ method: "GET", url: "/api/notifications" });
    expect(agentWork.statusCode).toBe(200);
    expect(outcomeWork.statusCode).toBe(200);
    const publicReads = JSON.stringify({
      lifecycle,
      agentWork: agentWork.json(),
      outcomeWork: outcomeWork.json(),
      notifications: notifications.json(),
    });
    expect(publicReads).toContain("Provider authentication was rejected.");
    expect(publicReads).not.toMatch(
      /HISTORICAL_REQUEST_UPDATE_MARKER_9ca2|private-request-migration|access_token/u,
    );

    const replaySeed = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Migration replay SSE proof" },
    });
    expect(replaySeed.statusCode).toBe(200);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const replayResponse = await fetch(`${address}/api/workspace/stream?lastEventId=0`);
    const replayBody = await readSseUntil(replayResponse, '"replayed":true');
    const cursorMatch = /"cursor":(\d+)/u.exec(replayBody);
    if (!cursorMatch) throw new Error("workspace stream cursor was not emitted");
    expect(replayBody).not.toMatch(
      /HISTORICAL_REQUEST_UPDATE_MARKER_9ca2|private-request-migration|access_token/u,
    );
    const liveResponse = await fetch(
      `${address}/api/workspace/stream?lastEventId=${cursorMatch[1]}`,
    );
    const liveBodyPromise = readSseUntil(liveResponse, '"type":"conversation_changed"');
    const createdConversation = await fetch(`${address}/api/projects/${project.id}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Migration live SSE proof" }),
    });
    expect(createdConversation.status).toBe(200);
    const liveBody = await liveBodyPromise;
    expect(liveBody).not.toMatch(
      /HISTORICAL_REQUEST_UPDATE_MARKER_9ca2|private-request-migration|access_token/u,
    );
    await app.close();
  }, 20_000);

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
