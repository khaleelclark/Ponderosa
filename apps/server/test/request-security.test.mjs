import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { classifyOperatorRequest, registerRequestSecurityHooks } from "../dist/server-request-hooks.js";
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
  app.get("/api/health", handler);
  app.get("/api/ready", handler);
  app.get("/api/workspace/stream", handler);
  app.get("/api/agents/:id/stream", handler);
  app.get("/api/agents/:id/export", handler);
  app.get("/api/streams/probe", handler);
  app.post("/api/projects", async () => ({ ok: true }));
  app.put("/api/conversations/:id/draft", handler);
  app.post("/api/conversations/:id/messages", handler);
  app.post("/api/conversations/:id/message-delivery-receipts", handler);
  app.post("/api/projects/:id/agents", handler);
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

test("direct private LAN browsers can read and mutate without a sign-in when explicitly trusted", async t => {
  const app = await fixture({ networkSecurity: { mode: "trusted_lan", bindHost: "192.168.1.147", authenticationRequired: false, detail: "test" } });
  t.after(() => app.close());
  const host = "192.168.1.147:18793";
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: { host } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" } })).statusCode, 200);
  for (const origin of ["http://192.168.1.148:18793", "http://192.168.1.147:18794", "https://192.168.1.147:18793", "http://malicious.example"]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers: { host, origin } })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: { host: "malicious.example" } })).statusCode, 421);
  assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers: { host, origin: `http://${host}`, "sec-fetch-site": "cross-site" } })).statusCode, 403);
});

test("direct authenticated LAN browser mutations still require authentication", async t => {
  const app = await fixture({ authToken: "secret", networkSecurity: { mode: "authenticated", bindHost: "192.168.1.147", authenticationRequired: true, detail: "test" } });
  t.after(() => app.close());
  const headers = { host: "192.168.1.147:18793", origin: "http://192.168.1.147:18793" };
  assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers: { ...headers, authorization: "Bearer secret" } })).statusCode, 200);
});

test("reverse proxies cannot use the direct listener origin admission", async t => {
  const app = await fixture({ networkSecurity: { mode: "reverse_proxy", bindHost: "192.168.1.147", authenticationRequired: true, detail: "test" }, operatorOrigins: ["https://ponderosa.example"] });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers: { host: "192.168.1.147:18793", origin: "http://192.168.1.147:18793" } })).statusCode, 403);
});

test("authenticated API and Agent exports are not retained by intermediary caches", async t => {
  const app = await fixture();
  t.after(() => app.close());
  for (const url of ["/api/projects", "/api/workspace/stream", "/api/agents/example/export"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
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
  assert.equal((await app.inject({ method: "POST", url: "/api/projects" })).statusCode, 429);
});

test("read-heavy operator activity does not exhaust the write admission bucket", async t => {
  const app = await fixture({ requestLimits: { maxRequestsPerMinute: 1, maxReadRequestsPerMinute: 3, maxInflight: 4 } });
  t.after(() => app.close());
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 429);
  assert.equal((await app.inject({ method: "POST", url: "/api/projects" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/projects" })).statusCode, 429);
});

test("health and readiness have a separate bounded budget from operator reads", async t => {
  const app = await fixture({ requestLimits: { maxRequestsPerMinute: 1, maxMonitorRequestsPerMinute: 2, maxInflight: 4 } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 429);
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/ready" })).statusCode, 200);
  const limited = await app.inject({ method: "GET", url: "/api/ready" });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
});

test("only operator-authored actions use reserved admission; read-like POSTs do not", async t => {
  assert.equal(classifyOperatorRequest("PUT", "/api/conversations/c/draft?ownerId=o"), "critical");
  assert.equal(classifyOperatorRequest("POST", "/api/conversations/c/messages"), "critical");
  assert.equal(classifyOperatorRequest("POST", "/api/agents/a/queued-messages/d/steer"), "critical");
  assert.equal(classifyOperatorRequest("POST", "/api/projects/p/agents"), "critical");
  assert.equal(classifyOperatorRequest("POST", "/api/projects"), "critical");
  assert.equal(classifyOperatorRequest("POST", "/api/conversations/c/message-delivery-receipts"), "standard");
  assert.equal(classifyOperatorRequest("GET", "/api/projects/p/agents"), "standard");
  assert.equal(classifyOperatorRequest("GET", "/api/workspace/stream?lastEventId=1"), "stream");
  assert.equal(classifyOperatorRequest("GET", "/api/agents/a/stream"), "stream");
  assert.equal(classifyOperatorRequest("GET", "/api/streams/probe"), "stream");
  assert.equal(classifyOperatorRequest("POST", "/api/workspace/stream"), "standard");

  const app = await fixture({
    authToken: "backend-secret",
    operatorIdentities: ["alice@example.test", "bob@example.test"],
    networkSecurity: { mode: "reverse_proxy", bindHost: "127.0.0.1", authenticationRequired: true, detail: "test" },
    requestLimits: { maxRequestsPerMinute: 1, maxCriticalRequestsPerMinute: 2, maxInflight: 4 },
  });
  t.after(() => app.close());
  const alice = { authorization: "Bearer backend-secret", "tailscale-user-login": "alice@example.test" };
  const bob = { authorization: "Bearer backend-secret", "tailscale-user-login": "bob@example.test" };
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: alice })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/conversations/c/message-delivery-receipts", headers: alice })).statusCode, 429);
  assert.equal((await app.inject({ method: "PUT", url: "/api/conversations/c/draft", headers: alice })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/conversations/c/messages", headers: alice })).statusCode, 200);
  const criticalLimit = await app.inject({ method: "POST", url: "/api/projects/p/agents", headers: alice });
  assert.equal(criticalLimit.statusCode, 429);
  assert.ok(criticalLimit.headers["retry-after"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers: bob })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/conversations/c/draft", headers: bob })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
});

test("busy background reads cannot exhaust authenticated stream or user-action admission", async t => {
  const app = await fixture({
    authToken: "operator-secret",
    requestLimits: { maxRequestsPerMinute: 1, maxStreamRequestsPerMinute: 3,
      maxCriticalRequestsPerMinute: 2, maxInflight: 8 },
  });
  t.after(() => app.close());
  const headers = { authorization: "Bearer operator-secret" };
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects", headers })).statusCode, 429);
  for (const url of ["/api/workspace/stream", "/api/agents/a/stream", "/api/streams/probe"]) {
    assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 200);
  }
  const streamLimited = await app.inject({ method: "GET", url: "/api/workspace/stream", headers });
  assert.equal(streamLimited.statusCode, 429);
  assert.ok(streamLimited.headers["retry-after"]);
  assert.equal((await app.inject({ method: "PUT", url: "/api/conversations/c/draft", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/conversations/c/messages", headers })).statusCode, 200);
});

test("twelve busy Agents across three tabs cannot starve draft saves and sends", async t => {
  const app = await fixture({
    authToken: "operator-secret",
    requestLimits: { maxRequestsPerMinute: 24, maxCriticalRequestsPerMinute: 12, maxInflight: 8 },
  });
  t.after(() => app.close());
  const headers = { authorization: "Bearer operator-secret" };
  for (let tab = 0; tab < 3; tab += 1) {
    for (let agent = 0; agent < 12; agent += 1) {
      const response = await app.inject({ method: "GET", url: `/api/projects?tab=${tab}&agent=${agent}`, headers });
      assert.equal(response.statusCode, tab < 2 ? 200 : 429);
    }
    assert.equal((await app.inject({ method: "PUT", url: "/api/conversations/c/draft", headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/conversations/c/messages", headers })).statusCode, 200);
  }
});

test("slow background reads leave bounded concurrency for an operator draft", async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let started = 0;
  let signalStarted;
  const bothStarted = new Promise(resolve => { signalStarted = resolve; });
  const app = await fixture({
    authToken: "operator-secret",
    requestLimits: { maxRequestsPerMinute: 20, maxCriticalRequestsPerMinute: 5, maxInflight: 3 },
  }, {}, async request => {
    if (request.method === "GET") {
      started += 1;
      if (started === 2) signalStarted();
      await pending;
    }
    return { ok: true };
  });
  t.after(() => app.close());
  const headers = { authorization: "Bearer operator-secret" };
  const first = app.inject({ method: "GET", url: "/api/projects?slot=1", headers });
  const second = app.inject({ method: "GET", url: "/api/projects?slot=2", headers });
  await bothStarted;
  assert.equal((await app.inject({ method: "GET", url: "/api/projects?slot=3", headers })).statusCode, 503);
  assert.equal((await app.inject({ method: "PUT", url: "/api/conversations/c/draft", headers })).statusCode, 200);
  finish();
  assert.deepEqual((await Promise.all([first, second])).map(response => response.statusCode), [200, 200]);
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
