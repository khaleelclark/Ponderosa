import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { registerRequestSecurityHooks } from "../../apps/server/dist/server-request-hooks.js";
import {
  registerAttachmentUploadLifecycle,
  retireAttachmentUpload,
} from "../../apps/server/dist/attachment-upload-lifecycle.js";

test("upload routes preserve Unicode and literal percent filenames and reject invalid encoding without leaking capacity", async () => {
  const app = Fastify();
  registerAttachmentUploadLifecycle(app, 1024);
  let handled = 0;
  const routes = [
    "/api/agents/example/attachments",
    "/api/conversations/example/attachments",
    "/api/conversations/example/draft-attachments",
  ];
  for (const route of routes) app.post(route, async (request) => {
    try {
      handled++;
      return { name: request.headers["x-ponderosa-filename"], body: request.body.toString("hex") };
    } finally {
      retireAttachmentUpload(request);
    }
  });
  const body = Buffer.from("complete fixture bytes");
  const upload = (url, name) => app.inject({
    method: "POST", url,
    headers: { "content-type": "application/x-ponderosa-attachment", "x-ponderosa-filename": name },
    payload: body,
  });
  try {
    for (const route of routes) {
      for (const name of ["普通の資料—résumé📎.txt", "100% ready %20 literal.txt", "plain.txt"]) {
        const reply = await upload(route, encodeURIComponent(name));
        assert.equal(reply.statusCode, 200);
        assert.deepEqual(reply.json(), { name, body: body.toString("hex") });
      }
      const before = handled;
      for (const invalid of ["%", "%GG", "%E0%A4"]) {
        const reply = await upload(route, invalid);
        assert.equal(reply.statusCode, 400);
        assert.equal(handled, before);
      }
      assert.equal((await upload(route, encodeURIComponent("retry📎.txt"))).statusCode, 200);
    }
  } finally {
    await app.close();
  }
});

const routes = ['/api/agents/owned/attachments', '/api/conversations/owned/attachments', '/api/conversations/owned/draft-attachments'];
const body = Buffer.from('owned synthetic image preparation bytes');
const bounded = promise => Promise.race([promise, delay(2000, undefined, { ref: false }).then(() => { throw Error('owned transport did not settle within test bound'); })]);

async function fixture(t, { idle = 50, deadline = 2000 } = {}) {
  const app = Fastify({ connectionTimeout: idle, requestTimeout: 120000, logger: false });
  const sockets = new Set(), releases = new Set();
  let entering, nextGate, stages = 0, completed = 0;
  registerAttachmentUploadLifecycle(app, 1024);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_r, b, done) => done(null, b));
  registerRequestSecurityHooks(app, {
    opts: { requestLimits: { maxRequestsPerMinute: 100, maxInflight: 1, handlerDeadlineMs: deadline } },
    v3DispatchKey: 'owned-fixture', agentMessageCapabilities: new Map(), deletingAgentIds: new Set(), validLauncherSession: () => false,
    artifactFilesystemError: () => undefined, isArtifactDependentWorkIntake: () => false, isPublicWebAssetRequest: () => false,
  });
  for (const route of routes) app.post(route, async (request, reply) => {
    try {
      stages++; const gate = nextGate; entering?.();
      await gate;
      assert.deepEqual(request.body, body);
      completed++;
      return reply.code(201).send({ body: request.body.toString('hex') });
    } finally { retireAttachmentUpload(request); }
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const release of releases) release();
    for (const request of sockets) request.destroy();
    app.server.closeAllConnections();
    await app.close();
  });
  return { app, get stages() { return stages; }, get completed() { return completed; },
    abortRequests() { for (const request of sockets) request.destroy(); },
    gate() {
      let release;
      const entered = new Promise(resolve => { entering = resolve; });
      nextGate = new Promise(resolve => { release = resolve; }); releases.add(release);
      return { entered, release: () => { releases.delete(release); release(); } };
    },
    wire(url, type, partial = false) {
      return new Promise(resolve => {
        const request = httpRequest(base + url, { method: 'POST', agent: false, headers: {
          'content-type': type, 'content-length': body.length, 'x-ponderosa-filename': 'owned.png',
        } }, response => {
          const chunks = []; response.on('data', bytes => chunks.push(bytes));
          response.once('error', e => resolve({ error: e.code }));
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        sockets.add(request); request.once('close', () => sockets.delete(request));
        request.once('error', error => resolve({ error: error.code }));
        if (partial) request.write(body.subarray(0, 1)); else request.end(body);
      });
    },
  };
}

for (const route of routes) for (const media of ['application/x-ponderosa-attachment', 'application/octet-stream']) {
  test(`complete upload body survives processing beyond socket idle: ${route} ${media}`, { timeout: 5000 }, async t => {
    const f = await fixture(t), gate = f.gate(), pending = f.wire(route, media);
    await bounded(gate.entered);
    await delay(200); // Four ordinary socket-idle periods; the body is already complete.
    gate.release();
    const reply = await bounded(pending);
    assert.equal(reply.status, 201, JSON.stringify(reply));
    assert.deepEqual(JSON.parse(reply.body), { body: body.toString('hex') });
    assert.equal(f.stages, 1); assert.equal(f.completed, 1);
  });
}

test('upload processing preserves handler 504 and admission until actual retirement', { timeout: 5000 }, async t => {
  const f = await fixture(t, { idle: 50, deadline: 120 }), gate = f.gate();
  const pending = f.wire(routes[1], 'application/x-ponderosa-attachment');
  await bounded(gate.entered);
  const reply = await bounded(pending);
  assert.equal(reply.status, 504, JSON.stringify(reply));
  assert.equal(f.completed, 0);
  assert.equal((await f.app.inject('/api/health')).statusCode, 503, 'processing still owns its admission slot');
  gate.release();
  for (let i = 0; i < 100 && !f.completed; i++) await delay(5);
  assert.equal(f.completed, 1);
  assert.equal((await f.app.inject('/api/health')).statusCode, 200);
});

for (const media of ['application/x-ponderosa-attachment', 'application/octet-stream', 'application/json']) {
test(`partial body retains socket inactivity timeout and releases admission: ${media}`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { idle: 50 }), pending = f.wire(routes[2], media, true);
  const reply = await bounded(pending);
  assert.equal(reply.error, 'ECONNRESET', JSON.stringify(reply));
  assert.equal(f.stages, 0);
  assert.equal((await f.app.inject('/api/health')).statusCode, 200);
});

test(`client abort before parsing releases admission: ${media}`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { idle: 2000 }), pending = f.wire(routes[2], media, true);
  // Observe the occupied slot before disconnecting, so this cannot pass merely
  // because the client disconnected before the server admitted its request.
  let status;
  for (let i = 0; i < 100; i++) {
    status = (await f.app.inject('/api/health')).statusCode;
    if (status === 503) break;
    await delay(5);
  }
  assert.equal(status, 503);
  f.abortRequests();
  assert.equal((await bounded(pending)).error, 'ECONNRESET');
  for (let i = 0; i < 100; i++) {
    status = (await f.app.inject('/api/health')).statusCode;
    if (status === 200) break;
    await delay(5);
  }
  assert.equal(status, 200);
  assert.equal(f.stages, 0);
});
}

test('disconnect during processing retains admission until the handler settles', { timeout: 5000 }, async t => {
  const f = await fixture(t), gate = f.gate();
  const pending = f.wire(routes[0], 'application/x-ponderosa-attachment');
  await bounded(gate.entered);
  f.abortRequests();
  assert.equal((await bounded(pending)).error, 'ECONNRESET');
  assert.equal((await f.app.inject('/api/health')).statusCode, 503);
  gate.release();
  for (let i = 0; i < 100 && !f.completed; i++) await delay(5);
  assert.equal(f.completed, 1);
  assert.equal((await f.app.inject('/api/health')).statusCode, 200);
});
