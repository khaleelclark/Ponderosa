import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { registerRequestSecurityHooks } from "../dist/server-request-hooks.js";
import { createLauncherSecurity } from "../dist/launcher-security.js";

async function fixture(options = {}, contextOverrides = {}, handler = async () => ({ ok: true })) {
  const app = Fastify({ logger: false });
  registerRequestSecurityHooks(app, {
    opts: {
      dataDir: "/tmp/unused",
      engines: [],
      networkSecurity: {
        mode: "loopback",
        bindHost: "127.0.0.1",
        authenticationRequired: false,
        detail: "test",
      },
      ...options,
    },
    v3DispatchKey: "dispatch",
    agentMessageCapabilities: new Map(),
    deletingAgentIds: new Set(),
    validLauncherSession: () => false,
    artifactFilesystemError: () => undefined,
    isArtifactDependentWorkIntake: () => false,
    isPublicWebAssetRequest: () => false,
    ...contextOverrides,
  });
  app.get("/api/projects", handler);
  app.post("/api/projects", async () => ({ ok: true }));
  await app.ready();
  return app;
}

test("loopback mode rejects a DNS-rebinding Host before reading operator data", async t => {
  const app = await fixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { host: "rebinding.example:8787", origin: "http://rebinding.example:8787" },
  });
  assert.equal(response.statusCode, 421);
});

test("configured origins admit same-origin mutations and reject cross-site fetches", async t => {
  const app = await fixture({ operatorOrigins: ["https://ponderosa.example"] });
  t.after(() => app.close());
  const accepted = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { host: "ponderosa.example", origin: "https://ponderosa.example", "sec-fetch-site": "same-origin" },
  });
  assert.equal(accepted.statusCode, 200);
  const rejected = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: { host: "ponderosa.example", origin: "https://ponderosa.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(rejected.statusCode, 403);
});

test("global request admission returns Retry-After instead of unbounded work", async t => {
  const app = await fixture({ requestLimits: { maxRequestsPerMinute: 1, maxInflight: 4 } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 200);
  const limited = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
});

test("a timed-out response retains admission until its handler settles", async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = await fixture({
    requestLimits: { maxRequestsPerMinute: 10, maxInflight: 1, handlerDeadlineMs: 20 },
  }, {}, async request => {
    if (request.headers["x-slow"] === "yes") await pending;
    return { ok: true };
  });
  t.after(() => app.close());
  const timedOut = await app.inject({ method: "GET", url: "/api/projects", headers: { "x-slow": "yes" } });
  assert.equal(timedOut.statusCode, 504);
  const blocked = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(blocked.statusCode, 503);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  const admitted = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(admitted.statusCode, 200);
});

test("a streamed response retains admission until transfer completes", async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let signalStart;
  const started = new Promise(resolve => { signalStart = resolve; });
  const app = await fixture({
    requestLimits: { maxRequestsPerMinute: 10, maxInflight: 1 },
  }, {}, async (request, reply) => {
    if (request.headers["x-stream"] !== "yes") return { ok: true };
    const response = reply.send(Readable.from((async function* () {
      yield "first";
      await pending;
      yield "second";
    })()));
    signalStart();
    return response;
  });
  t.after(() => app.close());
  const streaming = app.inject({ method: "GET", url: "/api/projects", headers: { "x-stream": "yes" } }).then(response => response);
  await started;
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 503);
  finish();
  assert.equal((await streaming).body, "firstsecond");
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 200);
});

test("trusted reverse proxy requires an allowed identity and backend bearer", async t => {
  const app = await fixture({
    authToken: "backend-secret",
    operatorOrigins: ["https://ponderosa.example"],
    operatorIdentities: ["operator@example.com"],
    networkSecurity: {
      mode: "reverse_proxy",
      bindHost: "127.0.0.1",
      authenticationRequired: true,
      detail: "test",
    },
  });
  t.after(() => app.close());
  const missing = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { host: "ponderosa.example" },
  });
  assert.equal(missing.statusCode, 401);
  const wrong = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { host: "ponderosa.example", "tailscale-user-login": "other@example.com" },
  });
  assert.equal(wrong.statusCode, 401);
  const accepted = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: {
      host: "ponderosa.example",
      "tailscale-user-login": "Operator@Example.com",
      authorization: "Bearer backend-secret",
    },
  });
  assert.equal(accepted.statusCode, 200);
});

test("trusted reverse proxy requires both asserted identity and configured backend token", async t => {
  const app = await fixture({
    authToken: "backend-secret",
    operatorOrigins: ["https://ponderosa.example"],
    operatorIdentities: ["operator@example.com"],
    networkSecurity: {
      mode: "reverse_proxy",
      bindHost: "127.0.0.1",
      authenticationRequired: true,
      detail: "test",
    },
  });
  t.after(() => app.close());
  const headers = {
    host: "ponderosa.example",
    "tailscale-user-login": "operator@example.com",
  };
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers })).statusCode, 401);
  assert.equal((await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { ...headers, authorization: "Bearer backend-secret" },
  })).statusCode, 200);
});

test("reverse proxy browser sessions never bypass asserted identity", async t => {
  const app = await fixture({
    authToken: "backend-secret",
    operatorOrigins: ["https://ponderosa.example"],
    operatorIdentities: ["operator@example.com"],
    networkSecurity: {
      mode: "reverse_proxy",
      bindHost: "127.0.0.1",
      authenticationRequired: true,
      detail: "test",
    },
  }, {
    validLauncherSession: cookie => cookie === "__Host-ponderosa_session=valid",
  });
  t.after(() => app.close());
  const cookie = "__Host-ponderosa_session=valid";
  assert.equal((await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { host: "ponderosa.example", cookie },
  })).statusCode, 401);
  assert.equal((await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: {
      host: "ponderosa.example",
      cookie,
      "tailscale-user-login": "operator@example.com",
    },
  })).statusCode, 200);
});

test("an active browser session renews its HttpOnly cookie without operator action", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let now = 1_700_000_000_000;
  const opts = {
    authToken: "backend-secret",
    launcherSecurity: { controlToken: "launcher-secret", sessionTtlMs: 60_000 },
    operatorOrigins: ["https://ponderosa.example"],
    operatorIdentities: ["operator@example.com"],
    networkSecurity: {
      mode: "reverse_proxy",
      bindHost: "127.0.0.1",
      authenticationRequired: true,
      detail: "test",
    },
  };
  const security = createLauncherSecurity({ dataDir: "/tmp/unused", engines: [], ...opts }, db, () => now);
  const token = security.issueLauncherSession();
  const app = await fixture(opts, { validLauncherSession: security.validLauncherSession });
  t.after(() => app.close());
  now += 31_000;
  const headers = {
    host: "ponderosa.example",
    "tailscale-user-login": "operator@example.com",
    cookie: `__Host-ponderosa_session=${token}`,
  };
  const wrongIdentity = await app.inject({
    method: "GET", url: "/api/projects",
    headers: { ...headers, "tailscale-user-login": "another@example.com" },
  });
  assert.equal(wrongIdentity.statusCode, 401);
  assert.equal(wrongIdentity.headers["set-cookie"], undefined);
  const response = await app.inject({ method: "GET", url: "/api/projects", headers });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"], /^__Host-ponderosa_session=.+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=60; Secure$/u);
  now += 30_000;
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers })).statusCode, 200);
});

test("an installed loopback browser session renews without a bearer or proxy", async t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let now = 1_700_000_000_000;
  const opts = { launcherSecurity: { controlToken: "launcher-secret", sessionTtlMs: 60_000 } };
  const security = createLauncherSecurity({ dataDir: "/tmp/unused", engines: [], ...opts }, db, () => now);
  const token = security.issueLauncherSession();
  const app = await fixture(opts, { validLauncherSession: security.validLauncherSession });
  t.after(() => app.close());
  now += 31_000;
  const response = await app.inject({
    method: "GET", url: "/api/projects",
    headers: { cookie: `ponderosa_session=${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["set-cookie"], /^ponderosa_session=.+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=60$/u);
});

test("unauthorized requests cannot exhaust the operator admission bucket", async t => {
  const app = await fixture({
    authToken: "backend-secret",
    requestLimits: { maxRequestsPerMinute: 1, maxInflight: 4 },
  });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
  const authorized = { authorization: "Bearer backend-secret" };
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: authorized })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: authorized })).statusCode, 429);
});
