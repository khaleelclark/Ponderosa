import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recoveryTestFiles, speechBrowserFiles, verifyRecoveryFiles } from '../../../.github/scripts/check-recovery.mjs';

const required = [...recoveryTestFiles, ...speechBrowserFiles];
test('recovery gate rejects every individually missing suite before partial Node path matching', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recovery-coverage-'));
  try {
    for (const file of required) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '// fixture');
    }
    await verifyRecoveryFiles(root);
    for (const file of required) {
      await rm(path.join(root, file));
      await assert.rejects(verifyRecoveryFiles(root), error => {
        assert.match(error.message, /Required recovery coverage/);
        assert.ok(error.message.includes(file));
        return true;
      });
      await writeFile(path.join(root, file), '// fixture');
    }
    await writeFile(path.join(root, required[0]), '');
    await assert.rejects(verifyRecoveryFiles(root), /gui-qualification-pid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release recovery recipe names real nonempty suites in the current checkout', async () => {
  await verifyRecoveryFiles(fileURLToPath(new URL('../../../', import.meta.url)));
});
