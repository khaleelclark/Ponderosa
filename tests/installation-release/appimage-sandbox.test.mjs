import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../../packaging/appimage/AppRun', import.meta.url));
const setup = fileURLToPath(new URL('../../packaging/appimage/install-sandbox.mjs', import.meta.url));

test('administrator setup rejects unknown options before touching host policy', () => {
  const result = spawnSync(process.execPath, [setup, '--unexpected'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
});

test('AppImage setup runs only the fixed helper, drops Node preload options and never starts Engine as root', {
  skip: process.platform === 'win32' ? 'AppImage POSIX entry point' : false,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-appimage-entry-'));
  try {
    const engine = path.join(root, 'usr/lib/ponderosa-engine');
    const bin = path.join(root, 'bin'), record = path.join(root, 'calls');
    mkdirSync(path.join(engine, 'resources/Ponderosa/runtime'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    writeFileSync(path.join(engine, 'resources/Ponderosa/runtime/node'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORD"\nprintf "options=%s path=%s\\n" "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" >> "$RECORD"\n', { mode: 0o755 });
    writeFileSync(path.join(engine, 'ponderosa-engine'), '#!/bin/sh\necho forbidden > "$RECORD"\n', { mode: 0o755 });
    const env = { ...process.env, APPDIR: root, PATH: `${bin}:/usr/bin:/bin`, RECORD: record,
      NODE_OPTIONS: '--require=must-not-load', NODE_PATH: 'must-not-load' };
    const rejected = spawnSync('/bin/sh', [entry, '--install-sandbox', 'extra'], { env, encoding: 'utf8' });
    assert.equal(rejected.status, 2); assert.equal(existsSync(record), false);
    const rootLaunch = spawnSync('/bin/sh', [entry, '--no-browser'], { env, encoding: 'utf8' });
    assert.equal(rootLaunch.status, 1); assert.equal(existsSync(record), false);
    const installed = spawnSync('/bin/sh', [entry, '--install-sandbox'], { env, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(readFileSync(record, 'utf8'), `${root}/ponderosa-sandbox/install-sandbox.mjs\noptions=unset path=unset\n`);

    // Escalation must reopen the image: root cannot inspect the user's private
    // FUSE-mounted Node executable before authentication.
    writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'pkexec'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORD"\nprintf "options=%s path=%s\\n" "${NODE_OPTIONS-unset}" "${NODE_PATH-unset}" >> "$RECORD"\nexit 126\n', { mode: 0o755 });
    const cancelled = spawnSync('/bin/sh', [entry, '--install-sandbox'], {
      env: { ...env, APPIMAGE: path.join(root, 'Ponderosa with spaces.AppImage') }, encoding: 'utf8',
    });
    assert.equal(cancelled.status, 126);
    assert.equal(readFileSync(record, 'utf8'), `${root}/Ponderosa with spaces.AppImage\n--install-sandbox\noptions=unset path=unset\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
