import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createOperatorAuthProxy, listenOperatorAuthProxy } from "../dist/operator-auth-proxy.js";
import { registerRequestSecurityHooks } from "../dist/server-request-hooks.js";

const token = "a".repeat(48);
const identity = "operator@example.com";

async function listen(server, path) {
  server.listen(path);
  await once(server, "listening");
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("private proxy requires identity, replaces browser authorization, and preserves requests", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-proxy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const backend = createServer(async (request, response) => {
    if (request.headers.origin !== `https://${request.headers.host}`) {
      response.writeHead(403);
      response.end("cross-origin mutation forbidden");
      return;
    }
    const body = [];
    for await (const chunk of request) body.push(chunk);
    seen.push({ headers: request.headers, url: request.url, body: Buffer.concat(body).toString() });
    response.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "test=value; HttpOnly" });
    response.end("accepted");
  });
  await listen(backend, 0);
  t.after(() => close(backend));
  const socketPath = join(root, "operator.sock");
  const proxy = await listenOperatorAuthProxy({
    socketPath,
    backendPort: backend.address().port,
    backendToken: token,
    publicOrigin: "https://example.test",
    identityHeader: "X-Verified-Operator",
    allowedIdentities: [identity],
  });
  t.after(() => close(proxy));
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);

  const send = async (headers, body = "payload") => {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ socketPath, path: "/api/projects?first=1", method: "POST", headers: {
        host: "localhost", origin: "https://example.test",
        "x-forwarded-host": "example.test", "content-type": "text/plain", ...headers,
      } }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };

  assert.equal((await send({})).status, 401);
  assert.equal((await send({ "x-verified-operator": "other@example.com" })).status, 401);
  assert.equal((await send({ "x-verified-operator": identity, "x-forwarded-host": "other.test" })).status, 421);
  assert.equal(seen.length, 0);
  const result = await send({
    "x-verified-operator": "OPERATOR@example.com",
    authorization: "Bearer browser-supplied-secret",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, "accepted");
  assert.deepEqual(result.headers["set-cookie"], ["test=value; HttpOnly"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${token}`);
  assert.equal(seen[0].headers.host, "example.test");
  assert.equal(seen[0].headers["x-verified-operator"], "OPERATOR@example.com");
  assert.equal(seen[0].url, "/api/projects?first=1");
  assert.equal(seen[0].body, "payload");
});

test("proxy rejects unsafe or incomplete startup configuration", () => {
  const valid = {
    socketPath: "/tmp/ponderosa-operator.sock",
    backendPort: 8787,
    backendToken: token,
    publicOrigin: "https://example.test",
    identityHeader: "x-verified-operator",
    allowedIdentities: [identity],
  };
  assert.throws(() => createOperatorAuthProxy({ ...valid, socketPath: "operator.sock" }), /absolute/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, backendToken: "short" }), /32 characters/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, publicOrigin: "http://example.test" }), /HTTPS origin/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, publicOrigin: "https://example.test/path" }), /HTTPS origin/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, identityHeader: "authorization" }), /invalid/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, allowedIdentities: [] }), /allowed identity/u);
});

test("Unix-target Host rewriting still admits real Ponderosa browser mutations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-proxy-origin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  registerRequestSecurityHooks(app, {
    opts: {
      dataDir: root,
      engines: [],
      authToken: token,
      operatorOrigins: ["https://example.test:25443"],
      operatorIdentities: [identity],
      networkSecurity: {
        mode: "reverse_proxy", bindHost: "127.0.0.1", authenticationRequired: true, detail: "test",
      },
    },
    v3DispatchKey: "dispatch",
    agentMessageCapabilities: new Map(),
    deletingAgentIds: new Set(),
    validLauncherSession: () => false,
    artifactFilesystemError: () => undefined,
    isArtifactDependentWorkIntake: () => false,
    isPublicWebAssetRequest: () => false,
  });
  app.post("/api/harmless", async () => ({ accepted: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const socketPath = join(root, "operator.sock");
  const proxy = await listenOperatorAuthProxy({
    socketPath,
    backendPort: app.server.address().port,
    backendToken: token,
    publicOrigin: "https://example.test:25443",
    identityHeader: "Tailscale-User-Login",
    allowedIdentities: [identity],
  });
  t.after(() => close(proxy));

  const send = (headers) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath, path: "/api/harmless", method: "POST", headers: {
      host: "localhost",
      "x-forwarded-host": "example.test:25443",
      "tailscale-user-login": identity,
      origin: "https://example.test:25443",
      ...headers,
    } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  assert.equal(await send({}), 200);
  assert.equal(await send({ origin: "https://other.test" }), 403);
  assert.equal(await send({ "x-forwarded-host": "other.test" }), 421);
  assert.equal(await send({ "tailscale-user-login": "other@example.com" }), 401);
});
