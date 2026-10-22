import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const main = process.env.PONDEROSA_TEST_INSTALL_ROOT
  ? path.join(process.env.PONDEROSA_TEST_INSTALL_ROOT, 'app/server/dist/main.js')
  : path.join(repository, 'apps/server/dist/main.js');

function bytes(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? bytes(target).map(([name, hash]) => [`${entry.name}/${name}`, hash])
      : [[entry.name, createHash('sha256').update(readFileSync(target)).digest('hex')]];
  });
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-admission-startup-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  mkdirSync(data); mkdirSync(home);
  // Valid JSON with an unsupported identity must take the explicit refusal path,
  // before SQLite or any runtime is allowed to open the preserved cohort.
  writeFileSync(path.join(data, '.ponderosa-layout-version'), JSON.stringify({ layoutVersion: 2, stateEpoch: 2, generationId: 'invalid' }));
  writeFileSync(path.join(data, 'ponderosa.db'), 'preserved unsupported database bytes');
  writeFileSync(path.join(data, 'ponderosa.db-wal'), 'preserved WAL bytes');
  writeFileSync(path.join(data, 'ponderosa.db-shm'), 'preserved SHM bytes');
  const listener = path.join(root, 'listener-called'), probe = path.join(root, 'observe-listen.mjs');
  writeFileSync(probe, `import { Server } from 'node:net';
import { writeFileSync } from 'node:fs';
Server.prototype.listen = function(...args) {
  writeFileSync(${JSON.stringify(listener)}, 'listen called');
  throw new Error('refused startup attempted a listener');
};\n`);
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    NODE_ENV: 'test', PONDEROSA_DATA_DIR: data, PONDEROSA_START_DRAINED: '1',
    PONDEROSA_HOST: '127.0.0.1', PONDEROSA_PORT: '48763', PONDEROSA_RELEASE_CHANNEL: 'test',
  };
  const invoke = extra => spawnSync(process.execPath, ['--import', pathToFileURL(probe).href, main], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  return { root, data, listener, invoke };
}

test('actual daemon refuses unsupported state with exit 78, preserving bytes and never listening', { timeout: 35_000 }, () => {
  const f = fixture(); let passed = false;
  try {
    const before = bytes(f.data), result = f.invoke();
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /unsupported or incomplete current state; existing bytes are preserved/);
    assert.deepEqual(bytes(f.data), before, 'refusal changed the preserved file cohort');
    assert.equal(existsSync(f.listener), false, 'refused startup attempted to listen');
    passed = true;
  } finally { if (passed) rmSync(f.root, { recursive: true, force: true }); }
});

test('ordinary production configuration failure retains exit 1 rather than admission exit 78', { timeout: 35_000 }, () => {
  const f = fixture(); let passed = false;
  try {
    const before = bytes(f.data), result = f.invoke({ PONDEROSA_RELEASE_CHANNEL: 'production', PONDEROSA_BUILD_SHA: 'invalid' });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /production startup requires exact PONDEROSA_BUILD_SHA and PONDEROSA_BUILD_VERSION/);
    assert.deepEqual(bytes(f.data), before);
    assert.equal(existsSync(f.listener), false);
    passed = true;
  } finally { if (passed) rmSync(f.root, { recursive: true, force: true }); }
});

test('checked-in daemon units prevent automatic restart only for admission exit 78', () => {
  for (const name of ['ponderosa.service', 'ponderosa-dev.service']) {
    const unit = readFileSync(path.join(repository, 'deploy', name), 'utf8');
    assert.match(unit, /^Restart=on-failure$/m, name);
    assert.match(unit, /^RestartPreventExitStatus=78$/m, name);
  }
});
