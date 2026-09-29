import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError } from "../src/api/types.js";
import { retryContendedAttachmentUpload } from "../src/api/uploadRetry.js";

const busy = (retryAfterMs = 1_000) => new ApiRequestError(
  503, "Two attachments are uploading", { code: "attachment_upload_busy" }, retryAfterMs,
);

test("upload contention honors Retry-After, then succeeds with the original operation", async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryContendedAttachmentUpload(async () => {
    attempts += 1;
    if (attempts < 3) throw busy(attempts === 1 ? 2_000 : 1_000);
    return { id: "same-upload" };
  }, undefined, async (delay) => { delays.push(delay); });
  assert.deepEqual(result, { id: "same-upload" });
  assert.equal(attempts, 3);
  assert.ok(delays[0] >= 2_000);
  assert.ok(delays[1] >= 2_000);
});

test("only the explicit upload-slot rejection retries, and retries are bounded", async () => {
  for (const error of [
    new ApiRequestError(503, "provider unavailable", { code: "provider_unavailable" }, 1_000),
    new ApiRequestError(429, "operator limited", undefined, 1_000),
    busy(46_000),
  ]) {
    let attempts = 0;
    await assert.rejects(retryContendedAttachmentUpload(async () => {
      attempts += 1;
      throw error;
    }, undefined, async () => {}), (actual) => actual === error);
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(retryContendedAttachmentUpload(async () => {
    attempts += 1;
    throw busy();
  }, undefined, async () => {}), (error) => error.status === 503);
  assert.equal(attempts, 7);
});

test("removing a draft file prevents another upload attempt after contention", async () => {
  let current = true;
  let attempts = 0;
  await assert.rejects(retryContendedAttachmentUpload(async () => {
    attempts += 1;
    throw busy();
  }, () => current, async () => { current = false; }), (error) => error.status === 503);
  assert.equal(attempts, 1);
});
