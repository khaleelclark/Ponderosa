import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError } from "../src/api/types.js";
import { recipientUploadControls } from "../src/components/recipientUploadControls.js";

test("both Chat send surfaces share exact upload-error classification", () => {
  const controls = recipientUploadControls({
    deleteAttachment: async () => {},
    onPendingDelta: () => {},
  });
  assert.equal(controls.recipientUnavailable(new ApiRequestError(404, "not found")), true);
  assert.equal(controls.recipientUnavailable(new ApiRequestError(503, "unavailable")), false);
  assert.equal(controls.cleanupSettled(new ApiRequestError(404, "not found")), true);
  assert.equal(controls.cleanupSettled(new ApiRequestError(409, "sent assets cannot be deleted")), true);
  assert.equal(controls.cleanupSettled(new ApiRequestError(409, "conflict")), false);
  assert.equal(controls.definitiveFailure(new ApiRequestError(400, "invalid input")), true);
  assert.equal(controls.definitiveFailure(new ApiRequestError(409, "id collision")), false);
  assert.equal(controls.definitiveFailure(new ApiRequestError(503, "unavailable")), false);
});

test("shared cleanup deletes only its owned uploads and settles known missing assets", async () => {
  const removed = [];
  const deltas = [];
  const controls = recipientUploadControls({
    deleteAttachment: async (agentId, attachmentId) => {
      removed.push([agentId, attachmentId]);
      throw new ApiRequestError(404, "not found");
    },
    onPendingDelta: delta => deltas.push(delta),
  });
  await controls.cleanupRecipientUploads([
    { agentId: "agent-a", attachments: [{ id: "asset-a" }] },
    { agentId: "agent-b", attachments: [{ id: "asset-b" }] },
  ]);
  assert.deepEqual(removed, [["agent-a", "asset-a"], ["agent-b", "asset-b"]]);
  assert.deepEqual(deltas, []);
  const report = controls.cleanupPendingReporter();
  report(2);
  report(1);
  report(0);
  assert.deepEqual(deltas, [1, -1]);
});
