import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOperatorAuthProxy, listenOperatorAuthProxy } from "../dist/operator-auth-proxy.js";

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
    identityHeader: "X-Verified-Operator",
    allowedIdentities: [identity],
  });
  t.after(() => close(proxy));
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);

  const send = async (headers, body = "payload") => {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ socketPath, path: "/api/projects?first=1", method: "POST", headers: {
        host: "example.test", "content-type": "text/plain", ...headers,
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
    identityHeader: "x-verified-operator",
    allowedIdentities: [identity],
  };
  assert.throws(() => createOperatorAuthProxy({ ...valid, socketPath: "operator.sock" }), /absolute/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, backendToken: "short" }), /32 characters/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, identityHeader: "authorization" }), /invalid/u);
  assert.throws(() => createOperatorAuthProxy({ ...valid, allowedIdentities: [] }), /allowed identity/u);
});
