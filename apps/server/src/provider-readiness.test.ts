import type { Adapter, EngineAuthStatus } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
