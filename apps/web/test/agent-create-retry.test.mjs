import assert from "node:assert/strict";
import test from "node:test";
import { retainIdempotentAttempt } from "../src/components/idempotentAttempt.js";
import {
  failedRecipientUploadCleanup,
  recipientActionSnapshot,
  recipientUploadCacheKey,
  recipientUploadsForAgentIds,
  retryRecipientUploadCleanup,
  stableMessageActionText,
  uploadFilesForRecipients,
} from "../src/conversationRouting.js";

test("Agent creation retries retain one identity until the submitted form changes", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const first = retainIdempotentAttempt(undefined, "payload-a", createId, () => ({ uploads: ["one"] }));
  const retry = retainIdempotentAttempt(first, "payload-a", createId, () => ({ uploads: ["two"] }));
  const changed = retainIdempotentAttempt(retry, "payload-b", createId, () => ({ uploads: [] }));

  assert.equal(retry, first);
  assert.equal(retry.idempotencyKey, "request-1");
  assert.deepEqual(retry.prepared.uploads, ["one"]);
  assert.equal(changed.idempotencyKey, "request-2");
});

test("recipient and broadcast-owner snapshots remain frozen across an ambiguous retry", () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const authored = {
    projectId: "project-a",
    agentId: "agent-a",
    handle: "old-name",
    currentHandle: "old-name",
    currentTitle: "Old Name",
  };
  const renamed = {
    ...authored,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const fingerprint = (text, binding) => JSON.stringify({
    text: stableMessageActionText(text, [binding]),
    mentionedAgentIds: [binding.agentId],
  });
  const first = retainIdempotentAttempt(
    undefined,
    fingerprint("#old-name continue", authored),
    createId,
    () => ({
      text: "#old-name continue",
      snapshot: recipientActionSnapshot(["agent-b", "agent-a"], "agent-a"),
    }),
  );
  const retry = retainIdempotentAttempt(
    first,
    fingerprint("#new-name continue", renamed),
    createId,
    () => ({
      text: "#new-name continue",
      snapshot: recipientActionSnapshot(["agent-a", "agent-c"], "agent-c"),
    }),
  );
  assert.equal(retry, first);
  assert.equal(retry.idempotencyKey, "request-1");
  assert.equal(retry.prepared.text, "#old-name continue");
  assert.deepEqual(retry.prepared.snapshot, {
    targetAgentIds: ["agent-a", "agent-b"],
    broadcastAttachmentOwnerAgentId: "agent-a",
  });
  assert.notEqual(
    recipientUploadCacheKey("direct", ["agent-a"]),
    recipientUploadCacheKey("direct", ["agent-b"]),
  );
});

test("partial delivery cleanup selects only this attempt's unavailable-recipient uploads", () => {
  const uploads = [
    { agentId: "delivered", attachments: [{ id: "file-delivered" }, { id: "paste-delivered" }] },
    { agentId: "archived", attachments: [{ id: "file-archived" }, { id: "paste-archived" }] },
  ];
  assert.deepEqual(
    recipientUploadsForAgentIds(uploads, ["archived"]),
    [uploads[1]],
  );
  assert.deepEqual(
    recipientUploadsForAgentIds(uploads, ["delivered"]),
    [uploads[0]],
  );
  assert.deepEqual(
    recipientUploadsForAgentIds(uploads, ["another-attempt"]),
    [],
  );
});

test("committed partial delivery retries only exact cleanup failures", async () => {
  const unavailable = [{
    agentId: "archived",
    attachments: [{ id: "file-archived" }, { id: "paste-archived" }],
  }];
  const firstPass = await failedRecipientUploadCleanup(
    unavailable,
    async (_agentId, item) => {
      if (item.id === "paste-archived") throw new Error("transient cleanup failure");
    },
  );
  assert.deepEqual(firstPass, [{
    agentId: "archived",
    attachments: [{ id: "paste-archived" }],
  }]);

  const attempts = new Map();
  const pendingCounts = [];
  await retryRecipientUploadCleanup(
    firstPass,
    async (_agentId, item) => {
      const attempt = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, attempt);
      if (attempt === 1) throw new Error("still transient");
    },
    count => pendingCounts.push(count),
    0,
  );
  assert.deepEqual([...attempts], [["paste-archived", 2]]);
  assert.deepEqual(pendingCounts, [1, 0]);
});

test("recipient-gone uploads keep live recipient copies and report an empty unavailable copy", async () => {
  const files = [
    new File(["file"], "file.txt"),
    new File(["paste"], "paste.txt"),
  ];
  const deleted = [];
  const result = await uploadFilesForRecipients(
    ["live", "gone"],
    files,
    async (agentId, file) => {
      if (agentId === "gone" && file.name === "paste.txt") {
        throw Object.assign(new Error("recipient gone"), { status: 404 });
      }
      return { id: `${agentId}:${file.name}` };
    },
    async (agentId, item) => { deleted.push(`${agentId}:${item.id}`); },
    error => error?.status === 404,
  );

  assert.deepEqual(result, [
    {
      agentId: "live",
      attachments: [{ id: "live:file.txt" }, { id: "live:paste.txt" }],
    },
    { agentId: "gone", attachments: [] },
  ]);
  assert.deepEqual(deleted, ["gone:gone:file.txt"]);
});

test("non-recipient upload failures still clean every successful copy", async () => {
  const files = [new File(["file"], "file.txt")];
  const deleted = [];
  await assert.rejects(
    uploadFilesForRecipients(
      ["live", "broken"],
      files,
      async (agentId, file) => {
        if (agentId === "broken") throw Object.assign(new Error("quota"), { status: 413 });
        return { id: `${agentId}:${file.name}` };
      },
      async (agentId, item) => { deleted.push(`${agentId}:${item.id}`); },
      error => error?.status === 404,
    ),
    /quota/,
  );
  assert.deepEqual(deleted, ["live:live:file.txt"]);
});
