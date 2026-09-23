import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerFilesRoute } from "../dist/routes/workspace-files.js";

test("chat file browser uses the chat root, refreshes live files, and rejects escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-files-"));
  const app = Fastify();
  try {
    await mkdir(path.join(root, "chat"));
    await writeFile(path.join(root, "outside.txt"), "private");
    await writeFile(path.join(root, "chat", "README.md"), "first");
    await writeFile(path.join(root, "chat", ".env"), "private");
    await symlink(path.join(root, "outside.txt"), path.join(root, "chat", "escape.txt"));
    registerFilesRoute(app, { store: { getConversation: id => id === "chat" ? { workingDirectory: path.join(root, "chat") } : undefined } });
    const get = p => app.inject({ method: "GET", url: `/api/conversations/chat/files?path=${encodeURIComponent(p)}` });
    const listing = await get("");
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.headers["cache-control"], "private, no-store");
    assert.deepEqual(listing.json().entries.map(e => e.name), ["README.md"]);
    assert.equal((await get("README.md")).json().content, "first");
    await writeFile(path.join(root, "chat", "README.md"), "updated");
    assert.equal((await get("README.md")).json().content, "updated");
    for (const p of ["../outside.txt", "escape.txt", ".env", "/etc/passwd"]) assert.equal((await get(p)).statusCode, 400);
    assert.equal((await app.inject("/api/conversations/missing/files")).statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
