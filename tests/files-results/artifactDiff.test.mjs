import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedPathDiff } from '../../apps/web/src/components/filePreview/artifactDiff.ts';

test('check 73: selected-file unified diff preserves complete hunks and does not display unrelated header paths', () => {
  const diff = 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1,2 +1,2 @@\n context\n-before 😀\n+after 😀\n';
  const preview = recordedPathDiff(diff, 'selected.txt');
  assert.ok(preview.includes('--- a/selected.txt')); assert.ok(preview.includes('+++ b/selected.txt'));
  assert.ok(preview.includes('-before 😀')); assert.ok(preview.includes('+after 😀')); assert.ok(!preview.includes('other.txt'));
  assert.equal(recordedPathDiff('@@ -1,2 +1,2 @@\n only one line', 'selected.txt'), undefined, 'Incomplete hunk claimed to be a readable diff');
});
