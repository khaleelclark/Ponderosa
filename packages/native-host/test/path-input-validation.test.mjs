import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  listSecureDirectory, readSecureFile, readSecureFileAsync,
  removeSecureFile, secureFileAuthoritySupported, writeSecureFileAtomic,
} from '../dist/index.js';

const native = createRequire(import.meta.url)('../build/Release/ponderosa_native.node');
const supported = secureFileAuthoritySupported();
const body = Buffer.from('ordinary file bytes\0including binary data');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-path-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'sentinel.txt'), body);
  return {
    root,
    unchanged() {
      assert.deepEqual(readdirSync(root), ['sentinel.txt']);
      assert.deepEqual(readFileSync(path.join(root, 'sentinel.txt')), body);
    },
  };
}

test('native entry points reject embedded terminators in roots before filesystem effects', { skip: !supported }, t => {
  const f = fixture(t);
  for (const root of [`${f.root}\0suffix`, `${f.root}\0`]) {
    assert.equal(native.readSecureFile(root, 'sentinel.txt', 1024, true), null);
    assert.equal(native.listSecureDirectory(root, ''), null);
    assert.throws(() => native.writeSecureFileAtomic(root, 'new/nested', 'new.txt', '.new.tmp', body), /invalid secure atomic file publication/);
    assert.throws(() => native.removeSecureFile(root, '', 'sentinel.txt', '.quarantine', ''), /invalid secure file removal/);
    f.unchanged();
  }
});

test('native relative paths and leaves reject embedded terminators before creating or removing entries', { skip: !supported }, t => {
  const f = fixture(t);
  for (const relative of ['sentinel.txt\0suffix', 'new\0suffix/nested', '..\0/nested']) {
    assert.equal(native.readSecureFile(f.root, relative, 1024, true), null);
    assert.equal(native.listSecureDirectory(f.root, relative), null);
    assert.throws(() => native.writeSecureFileAtomic(f.root, relative, 'new.txt', '.new.tmp', body), /invalid secure atomic file publication/);
    assert.throws(() => native.removeSecureFile(f.root, relative, 'sentinel.txt', '.quarantine', ''), /invalid secure file removal/);
    f.unchanged();
  }
  for (const [leaf, temporary] of [['new.txt\0suffix', '.new.tmp'], ['new.txt', '.new.tmp\0suffix']]) {
    assert.throws(() => native.writeSecureFileAtomic(f.root, 'new/nested', leaf, temporary, body), /invalid secure atomic file publication/);
    f.unchanged();
  }
  for (const [leaf, quarantine] of [['sentinel.txt\0suffix', '.quarantine'], ['sentinel.txt', '.quarantine\0suffix']]) {
    assert.throws(() => native.removeSecureFile(f.root, '', leaf, quarantine, ''), /invalid secure file removal/);
    f.unchanged();
  }
});

test('public APIs validate malformed roots and relative paths before native calls or worker creation', { skip: !supported }, t => {
  const f = fixture(t);
  for (const root of [`${f.root}\0suffix`, `${f.root}\0`]) {
    assert.throws(() => readSecureFile({root, relativePath:'sentinel.txt', maxBytes:1024}), /root must not contain NUL/);
    // Synchronous assertion proves rejection precedes creating the async worker.
    assert.throws(() => readSecureFileAsync({root, relativePath:'sentinel.txt', maxBytes:1024}), /root must not contain NUL/);
    assert.throws(() => listSecureDirectory({root}), /root must not contain NUL/);
    assert.throws(() => writeSecureFileAtomic({root, relativeDirectory:'new/nested', leaf:'new.txt', temporaryLeaf:'.new.tmp', body}), /root must not contain NUL/);
    assert.throws(() => removeSecureFile({root, leaf:'sentinel.txt'}), /root must not contain NUL/);
    f.unchanged();
  }
  for (const relative of ['sentinel.txt\0suffix', 'new\0suffix/nested', '..\0/nested']) {
    assert.throws(() => readSecureFile({root:f.root, relativePath:relative, maxBytes:1024}), /bounded relative path/);
    assert.throws(() => readSecureFileAsync({root:f.root, relativePath:relative, maxBytes:1024}), /bounded relative path/);
    assert.throws(() => listSecureDirectory({root:f.root, relativePath:relative}), /bounded relative path/);
    assert.throws(() => writeSecureFileAtomic({root:f.root, relativeDirectory:relative, leaf:'new.txt', temporaryLeaf:'.new.tmp', body}), /bounded relative path/);
    assert.throws(() => removeSecureFile({root:f.root, relativeDirectory:relative, leaf:'sentinel.txt'}), /bounded relative path/);
    f.unchanged();
  }
});

test('public publication and removal retain existing leaf validation', { skip: !supported }, t => {
  const f = fixture(t);
  for (const [leaf, temporaryLeaf] of [['new.txt\0suffix', '.new.tmp'], ['new.txt', '.new.tmp\0suffix']]) {
    assert.throws(() => writeSecureFileAtomic({root:f.root, relativeDirectory:'new/nested', leaf, temporaryLeaf, body}), /bounded path leaf/);
    f.unchanged();
  }
  assert.throws(() => removeSecureFile({root:f.root, leaf:'sentinel.txt\0suffix'}), /bounded path leaf/);
  f.unchanged();
});

test('ordinary valid paths and binary content still work through native and public variants', { skip: !supported }, async t => {
  const f = fixture(t);
  assert.deepEqual(native.readSecureFile(f.root, 'sentinel.txt', 1024, true), body);
  assert.deepEqual(readSecureFile({root:f.root, relativePath:'sentinel.txt', maxBytes:1024}), body);
  assert.deepEqual(await readSecureFileAsync({root:f.root, relativePath:'sentinel.txt', maxBytes:1024}), body);
  assert.equal(native.listSecureDirectory(f.root, '')[0].name, 'sentinel.txt');
  assert.equal(listSecureDirectory({root:f.root})[0].name, 'sentinel.txt');
  assert.equal(native.writeSecureFileAtomic(f.root, 'native/nested', 'valid.txt', '.valid.tmp', body), true);
  assert.deepEqual(native.readSecureFile(f.root, 'native/nested/valid.txt', 1024, true), body);
  assert.equal(native.removeSecureFile(f.root, 'native/nested', 'valid.txt', '.quarantine', ''), true);
  writeSecureFileAtomic({root:f.root, relativeDirectory:'public/nested', leaf:'valid.txt', temporaryLeaf:'.valid.tmp', body});
  assert.deepEqual(await readSecureFileAsync({root:f.root, relativePath:'public/nested/valid.txt', maxBytes:1024}), body);
  const entry = listSecureDirectory({root:f.root, relativePath:'public/nested'})[0];
  assert.equal(removeSecureFile({root:f.root, relativeDirectory:'public/nested', leaf:entry.name, expectedIdentity:entry.identity}), true);
  assert.deepEqual(readFileSync(path.join(f.root, 'sentinel.txt')), body);
});
