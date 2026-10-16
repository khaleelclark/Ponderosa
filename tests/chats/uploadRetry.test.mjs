import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiRequestError } from '../../apps/web/src/api/types.ts';
import { retryContendedAttachmentUpload } from '../../apps/web/src/api/uploadRetry.ts';

test('check 22: only definite upload-slot rejection is retried, with one successful mutation', async () => {
  let attempts = 0, successful = 0;
  const receipt = { id: 'one-attachment' };
  assert.equal(await retryContendedAttachmentUpload(async () => {
    if (++attempts < 3) throw new ApiRequestError(503, 'Upload slot busy', { code: 'attachment_upload_busy' }, 1);
    successful++; return receipt;
  }, () => true, async () => {}), receipt);
  assert.equal(attempts, 3); assert.equal(successful, 1);
  for (const error of [new Error('Response lost'), new ApiRequestError(503, 'Other failure'), new ApiRequestError(413, 'Too large')]) {
    let calls = 0;
    await assert.rejects(retryContendedAttachmentUpload(async () => { calls++; throw error; }, () => true, async () => {}), e => e === error);
    assert.equal(calls, 1, 'Ambiguous mutation was repeated');
  }
});

test('check 22: a superseded draft stops a pending upload retry', async () => {
  let current = true, calls = 0;
  const error = new ApiRequestError(503, 'Upload slot busy', { code: 'attachment_upload_busy' });
  await assert.rejects(retryContendedAttachmentUpload(async () => { calls++; throw error; }, () => current, async () => { current = false; }), e => e === error);
  assert.equal(calls, 1);
});
