import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { registerAgentPackageRoutes } from "../dist/routes/agent-packages.js";

function registerImportRoutes(app, dataDir) {
  registerAgentPackageRoutes(app, {
    dataDir,
    store: { getProject: (id) => ({ id }) },
    coordination: {},
    assets: {},
    engines: new Map(),
    deletingProjectIds: new Set(),
    deletingConversationIds: new Set(),
    deletingAgentIds: new Set(),
    agentCreationConversationLeases: new Map(),
    cachedModelOptions: () => [],
    appendWorkspace: () => {},
    agentMessages: () => [],
    createOperationalNotification: () => {},
  });
}

test("background import idempotency is bound to the exact payload", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-operation-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerImportRoutes(app, dataDir);
  const headers = {
    "content-type": "application/vnd.ponderosa.agent-import",
    "idempotency-key": "same-request",
  };
  const first = await app.inject({ method: "POST", url: "/api/projects/project-a/agent-import-operations", headers, payload: Buffer.from("first") });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().payloadHash, createHash("sha256").update("first").digest("hex"));

  const conflict = await app.inject({ method: "POST", url: "/api/projects/project-a/agent-import-operations", headers, payload: Buffer.from("different") });
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /reused with different input/u);
});

test("startup hydration removes payloads for terminal import operations", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-hydration-"));
  const directory = path.join(dataDir, "agent-import-operations");
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const payload = path.join(directory, `${id}.payload`);
  const now = new Date().toISOString();
  await writeFile(payload, "already consumed");
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
    id,
    requestId: "terminal-request",
    payloadHash: createHash("sha256").update("already consumed").digest("hex"),
    projectId: "project-a",
    sourceLabel: "Agent import",
    phase: "completed",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    result: { rootAgentId: "agent-a", agentIds: ["agent-a"] },
  }));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  registerImportRoutes(app, dataDir);
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/project-a/agent-import-operations/${id}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(existsSync(payload), false);
});

test("a failed operation directory sync is never acknowledged from read-back", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-import-fsync-"));
  const directory = path.join(dataDir, "agent-import-operations");
  const app = Fastify();
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  t.after(async () => {
    fs.open = originalOpen;
    fs.unlink = originalUnlink;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  registerImportRoutes(app, dataDir);
  fs.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args);
    if (String(target) !== directory || flags !== "r") return handle;
    return new Proxy(handle, {
      get(object, property) {
        if (property === "sync") return async () => { throw new Error("injected directory sync failure"); };
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  };
  fs.unlink = async (target, ...args) => {
    if (String(target).startsWith(`${directory}${path.sep}`) && String(target).endsWith(".json")) {
      throw new Error("injected rollback failure");
    }
    return originalUnlink(target, ...args);
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/projects/project-a/agent-import-operations",
    headers: {
      "content-type": "application/vnd.ponderosa.agent-import",
      "idempotency-key": "failed-fsync-request",
    },
    payload: Buffer.from("payload"),
  });
  assert.equal(response.statusCode, 500);
});
