import assert from "node:assert/strict";
import test from "node:test";
import { retainIdempotentAttempt } from "../src/components/idempotentAttempt.js";
import {
  recipientActionSnapshot,
  recipientUploadCacheKey,
  recipientUploadsForAgentIds,
  stableMessageActionText,
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
