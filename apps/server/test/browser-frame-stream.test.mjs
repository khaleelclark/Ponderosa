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
