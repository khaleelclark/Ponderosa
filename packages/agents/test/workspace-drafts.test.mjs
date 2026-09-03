import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceStore } from "../dist/index.js";

test("conversation drafts retain stable mention bindings after restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-draft-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mentionBindings = [{
    projectId: "project-a",
    agentId: "agent-a",
    handle: "old-name",
    currentHandle: "old-name",
    currentTitle: "Old Name",
  }];
  const store = new WorkspaceStore(directory);
  store.putDraft("chat-a", {
    ownerId: "browser-a",
    text: "#old-name continue",
    attachmentIds: [],
    mentionBindings,
    expectedRevision: 0,
    clientId: "page:a",
  });

  assert.deepEqual(
    new WorkspaceStore(directory).getDraft("chat-a", "browser-a").mentionBindings,
    mentionBindings,
  );
});
