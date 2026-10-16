import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
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
