import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerBrowserRoutes } from "../dist/routes/browsers.js";

test("browser frame stream emits changed frames and releases its shutdown registration on disconnect", async () => {
  const app = Fastify();
  const closures = new Set();
  let observations = 0;
  registerBrowserRoutes(app, {
    liveSseClosures: closures,
    projectExists: id => id === "chat",
    browserProfiles: { savedBrowser: () => undefined },
    projectBrowserScope: projectId => ({ projectId, agentId: "browser", runId: "shared" }),
    projectBrowserSessions: {
      previewFrame: async () => {
        observations++;
        return {
          body: Buffer.from([255, 216, 255, 1]),
          mediaType: "image/jpeg", sequence: 1,
          metadata: { pageId: "one", viewport: { width: 1280, height: 720 },
            ...(observations >= 3 ? { activity: { pageId: "one", kind: "click", x: 20, y: 30, at: 123 } } : {}) },
        };
      },
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  try {
    const response = await fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    let text = "";
    while ((text.match(/event: frame/g) ?? []).length < 2) {
      const next = await reader.read();
      assert.equal(next.done, false);
      text += new TextDecoder().decode(next.value);
    }
    assert.match(text, /"mediaType":"image\/jpeg"/);
    assert.match(text, /"kind":"click"/, "an Agent action without a repaint still reaches the viewer");
    assert.equal(closures.size, 1);
    abort.abort();
    for (let attempt = 0; attempt < 50 && closures.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closures.size, 0, "disconnect must release the live stream");
  } finally {
    abort.abort();
    for (const close of closures) close();
    await app.close();
  }
});

test("idle compatibility preview emits observable heartbeat events", async () => {
  const app = Fastify();
  const closures = new Set();
  registerBrowserRoutes(app, {
    liveSseClosures: closures,
    projectExists: id => id === "chat",
    browserProfiles: { savedBrowser: () => undefined },
    projectBrowserScope: projectId => ({ projectId, agentId: "browser", runId: "shared" }),
    projectBrowserSessions: { previewFrame: async () => ({
      body: Buffer.from([255, 216, 255, 1]), mediaType: "image/jpeg", sequence: 1,
      metadata: { pageId: "one", viewport: { width: 1280, height: 720 } },
    }) },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 13_000);
  try {
    const response = await fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream`, { signal: abort.signal });
    const reader = response.body.getReader();
    let observed = "";
    const deadline = Date.now() + 13_000;
    while (!observed.includes("event: heartbeat") && Date.now() < deadline) {
      const next = await reader.read();
      assert.equal(next.done, false);
      observed += new TextDecoder().decode(next.value);
    }
    assert.match(observed, /event: heartbeat\ndata: \{\}\n\n/);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    for (const close of closures) close();
    await app.close();
  }
});

test("binary browser preview sends raw image bytes and releases its subscriber", async () => {
  const app = Fastify();
  const closures = new Set();
  const pixels = Buffer.from([255, 216, 255, 1]);
  registerBrowserRoutes(app, {
    liveSseClosures: closures,
    projectExists: id => id === "chat",
    browserProfiles: { savedBrowser: () => undefined },
    projectBrowserScope: projectId => ({ projectId, agentId: "browser", runId: "shared" }),
    projectBrowserSessions: { previewFrame: async () => ({ body: pixels, mediaType: "image/jpeg", sequence: 1,
      metadata: { pageId: "one", viewport: { width: 1280, height: 720 } } }) },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const abort = new AbortController();
  try {
    const response = await fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream?format=binary`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/vnd.ponderosa.browser-frames");
    const reader = response.body.getReader();
    let data = Buffer.alloc(0);
    while (data.length < 8 || data.length < 8 + data.readUInt32BE(0) + data.readUInt32BE(4)) {
      const next = await reader.read();
      assert.equal(next.done, false);
      data = Buffer.concat([data, Buffer.from(next.value)]);
    }
    const metadataLength = data.readUInt32BE(0);
    assert.equal(data.readUInt32BE(4), pixels.length);
    assert.equal(JSON.parse(data.subarray(8, 8 + metadataLength).toString()).metadata.pageId, "one");
    assert.deepEqual(data.subarray(8 + metadataLength, 8 + metadataLength + pixels.length), pixels);
    assert.equal(closures.size, 1);
    abort.abort();
    for (let attempt = 0; attempt < 50 && closures.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closures.size, 0);
  } finally {
    abort.abort();
    for (const close of closures) close();
    await app.close();
  }
});

test("a delayed first frame still occupies one of the eight preview slots", async () => {
  const app = Fastify();
  const closures = new Set();
  let captures = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  registerBrowserRoutes(app, {
    liveSseClosures: closures,
    projectExists: id => id === "chat",
    browserProfiles: { savedBrowser: () => undefined },
    projectBrowserScope: projectId => ({ projectId, agentId: "browser", runId: "shared" }),
    projectBrowserSessions: { previewFrame: async () => {
      captures++;
      await gate;
      return { body: Buffer.from([255, 216, 255, 1]), mediaType: "image/jpeg", sequence: 1,
        metadata: { pageId: "one", viewport: { width: 1280, height: 720 } } };
    } },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  try {
    const requests = controllers.map(controller => fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream`, { signal: controller.signal }));
    const deadline = Date.now() + 5_000;
    while (captures < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(captures, 8, "no ninth capture may begin while eight first frames are pending");
    release();
    const responses = await Promise.all(requests);
    assert.equal(responses.filter(response => response.status === 200).length, 8);
    assert.equal(responses.filter(response => response.status === 429).length, 4);
    assert.equal(closures.size, 8);
  } finally {
    release();
    controllers.forEach(controller => controller.abort());
    for (let attempt = 0; attempt < 50 && closures.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closures.size, 0, "disconnect releases every reserved stream");
    await app.close();
  }
});

test("failed first captures release preview reservations", async () => {
  const app = Fastify();
  const closures = new Set();
  let captures = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  registerBrowserRoutes(app, {
    liveSseClosures: closures,
    projectExists: id => id === "chat",
    browserProfiles: { savedBrowser: () => undefined },
    projectBrowserScope: projectId => ({ projectId, agentId: "browser", runId: "shared" }),
    projectBrowserSessions: { previewFrame: async () => {
      captures++;
      await gate;
      throw new Error("capture failed");
    } },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const pending = Array.from({ length: 8 }, () => fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream`));
    const deadline = Date.now() + 5_000;
    while (captures < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(captures, 8);
    assert.equal((await fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream`)).status, 429);
    release();
    assert.deepEqual((await Promise.all(pending)).map(response => response.status), Array(8).fill(500));
    assert.equal((await fetch(`${app.listeningOrigin}/api/projects/chat/browser/frame-stream`)).status, 500,
      "a failed first frame must not permanently consume a slot");
    assert.equal(closures.size, 0);
  } finally {
    release();
    for (const close of closures) close();
    await app.close();
  }
});
