import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const server = process.env.PONDEROSA_TEST_INSTALL_ROOT
  ? path.join(process.env.PONDEROSA_TEST_INSTALL_ROOT, 'app/server') : path.join(repository, 'apps/server');
const require = createRequire(path.join(server, 'package.json'));
const agentsUrl = pathToFileURL(path.join(path.dirname(require.resolve('@ponderosa/agents')), 'state-admission.js')).href;
const linux = { skip: process.platform !== 'linux' && 'Linux POSIX SQLite lock/SHM regression' };

// Every native-risk case is a bounded, core-disabled child. The parent owns and
// removes its random temporary directory even if the original bug SIGBUSes it.
function runCase(mode) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-admission-locks-'));
  const source = `(${worker.toString()})(${JSON.stringify({ mode, root, agentsUrl })})`;
  try {
    const result = spawnSync('python3', ['-c',
      'import os,resource,sys\nresource.setrlimit(resource.RLIMIT_CORE,(0,0))\nos.execv(sys.argv[1],sys.argv[1:])',
      process.execPath, '--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr || `native child received ${result.signal}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('admission keeps live SQLite DB and SHM locks until its final reference closes', linux, () => {
  const result = runCase('locks');
  assert.deepEqual(result.held, { db: 'blocked', shm: 'blocked' });
  assert.deepEqual(result.released, { db: 'available', shm: 'absent' });
});

test('admitted SQLite survives independent read-only SQLite open/query/close cycles', linux, () => {
  const result = runCase('queries');
  assert.equal(result.readerExit, 0);
  assert.equal(result.readerCycles, 100);
  assert.ok(result.queries >= 100);
});

test('read-only SQLite changing SHM during admission still refuses, releases authority, and permits a clean retry', linux, () => {
  const result = runCase('readonly-race');
  assert.equal(result.triggered, true);
  assert.match(result.refusal, /unsupported or incomplete current state/u);
  assert.equal(result.retry, 'admitted');
  assert.match(result.refusal, /ponderosa\.db-shm: .+ changed during admission/u);
  assert.ok(!result.refusal.includes(os.tmpdir()), 'diagnostic exposes no host path');
});

test('launcher-style inherited admission preserves generation and revalidates before releasing its lease', linux, () => {
  assert.equal(runCase('transfer').transferred, true);
});

for (const guard of ['metadata', 'hash', 'cohort', 'symlink', 'hardlink', 'generation', 'expected']) {
  test(`admission keeps its ${guard} safeguard and releases a failed acquisition`, linux, () => {
    const result = runCase(guard);
    assert.equal(result.triggered, true);
    assert.match(result.refusal, /unsupported or incomplete current state/u);
    assert.equal(result.authorityReleased, true);
    if (guard === 'hash') assert.match(result.refusal, /ponderosa\.db: content changed during admission/u);
    if (guard === 'metadata') assert.match(result.refusal, /ponderosa\.db: (mtimeNs|ctimeNs) changed during admission/u);
    if (guard === 'cohort') assert.match(result.refusal, /ponderosa\.db-journal: cohort membership changed during admission/u);
    assert.equal(result.fixtureDescriptors, 0);
  });
}

async function worker({ mode, root, agentsUrl }) {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { spawn, spawnSync } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { randomUUID } = await import('node:crypto');
  const { admitDataDirectory } = await import(agentsUrl);
  const { DataDirectoryAuthority } = await import(new URL('../../native-host/dist/index.js', agentsUrl));
  const filename = path.join(root, 'ponderosa.db');
  const python = (source, args = []) => {
    const result = spawnSync('python3', ['-c', source, filename, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const read = "import sqlite3,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=1)\nc.execute('select count(*) from sqlite_master').fetchone()\nc.close()";
  const probe = () => JSON.parse(python(`import errno,fcntl,json,os,sys
result={}
for name,suffix,start,length in [('db','',0,0),('shm','-shm',128,1)]:
 try: fd=os.open(sys.argv[1]+suffix,os.O_RDWR)
 except FileNotFoundError: result[name]='absent'; continue
 try:
  try: fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB,length,start); result[name]='available'
  except OSError as error:
   if error.errno not in (errno.EAGAIN,errno.EACCES): raise
   result[name]='blocked'
 finally: os.close(fd)
print(json.dumps(result))`));
  const initialized = admitDataDirectory(root);
  const generation = initialized.generationId;
  initialized.close();
  // A clean terminated fixture writer leaves real WAL and SHM to admit. No
  // extra table or schema modification is needed: the generation value is kept.
  python("import sqlite3,os,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute('pragma journal_mode=WAL')\nc.execute('pragma wal_autocheckpoint=0')\ngeneration=c.execute('select generation_id from _state_generation').fetchone()[0]\nc.execute('update _state_generation set generation_id=?',('00000000-0000-4000-8000-000000000000',))\nc.commit()\nc.execute('update _state_generation set generation_id=?',(generation,))\nc.commit()\nos._exit(0)");
  assert.ok(fs.statSync(filename + '-wal').size > 0);
  assert.ok(fs.statSync(filename + '-shm').size > 0);

  if (mode === 'locks' || mode === 'queries') {
    const admission = admitDataDirectory(root), retained = admission.retain();
    let result;
    try {
      assert.equal(admission.generationId, generation);
      if (mode === 'locks') {
        const held = probe();
        admission.close();
        assert.deepEqual(probe(), held, 'a retained reference still owns SQLite and the physical lease');
        retained.close();
        result = { held, released: probe() };
      } else {
        const reader = spawn('python3', ['-c', `import signal,sqlite3,sys
signal.alarm(5)
for i in range(100):
 c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=1)
 c.execute('select count(*) from sqlite_master').fetchone()
 c.close()
print(100)`, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = '';
        reader.stdout.on('data', chunk => output += chunk);
        reader.stderr.on('data', chunk => errors += chunk);
        const done = new Promise((resolve, reject) => {
          reader.once('error', reject); reader.once('exit', code => resolve(code));
        });
        const query = admission.client.prepare('select generation_id from _state_generation where singleton=1');
        let queries = 0;
        try {
          const until = Date.now() + 1000;
          while (Date.now() < until) { assert.equal(query.get().generation_id, generation); queries++; }
          const readerExit = await done;
          assert.equal(errors, '');
          result = { queries, readerExit, readerCycles: Number(output.trim()) };
        } finally { if (reader.exitCode === null) reader.kill(); }
      }
    } finally { retained.close(); admission.close(); }
    console.log(JSON.stringify(result));
    return;
  }

  if (mode === 'transfer') {
    const parent = admitDataDirectory(root);
    try {
      const transfer = parent.prepareTransfer();
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { admitDataDirectory } = await import(${JSON.stringify(agentsUrl)});
        const admission = admitDataDirectory('/proc/self/fd/4', 'ponderosa.db', 4, ${JSON.stringify(transfer)});
        try {
          if (admission.generationId !== ${JSON.stringify(generation)} ||
              admission.client.prepare('select generation_id from _state_generation').get().generation_id !== ${JSON.stringify(generation)})
            throw new Error('inherited generation changed');
        } finally { admission.close(); }
      `], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe', 'ignore', transfer.descriptor] });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr);
      parent.revalidateTransferredState();
    } finally { parent.close(); }
    console.log(JSON.stringify({ transferred: true }));
    return;
  }

  const originalRead = fs.readSync;
  const originalFstat = fs.fstatSync;
  let triggered = false, armed = true, refusal;
  const isSource = fd => {
    try { return fs.readlinkSync('/proc/self/fd/' + fd) === filename; } catch { return false; }
  };
  // The hash case hides only timestamp differences from fstat, leaving the
  // descriptor bytes different. A second hook also masks pathname timestamps
  // only for that file so the content-hash check itself must catch it.
  let captured;
  const originalLstat = fs.lstatSync;
  fs.fstatSync = function(fd, ...args) {
    const stat = originalFstat(fd, ...args);
    if (mode === 'hash' && isSource(fd)) {
      captured ??= stat;
      if (triggered) { stat.mtimeNs = captured.mtimeNs; stat.ctimeNs = captured.ctimeNs; }
    }
    return stat;
  };
  fs.lstatSync = function(name, ...args) {
    const stat = originalLstat(name, ...args);
    if (mode === 'hash' && triggered && stat && captured && String(name).endsWith('/ponderosa.db')) {
      stat.mtimeNs = captured.mtimeNs; stat.ctimeNs = captured.ctimeNs;
    }
    return stat;
  };
  fs.readSync = function(fd, ...args) {
    const count = originalRead(fd, ...args);
    let target = ''; try { target = fs.readlinkSync('/proc/self/fd/' + fd); } catch {}
    if (armed && !triggered && target === filename + (mode === 'readonly-race' ? '-shm' : '')) {
      triggered = true;
      if (mode === 'readonly-race') python(read);
      else if (mode === 'metadata') fs.utimesSync(filename, new Date(0), new Date(0));
      else if (mode === 'hash') {
        const writer = fs.openSync(filename, 'r+');
        try {
          const byte = Buffer.alloc(1); originalRead(writer, byte, 0, 1, 100); byte[0] ^= 1;
          fs.writeSync(writer, byte, 0, 1, 100);
        } finally { fs.closeSync(writer); }
      } else if (mode === 'cohort') fs.writeFileSync(filename + '-journal', 'unexpected');
      else if (mode === 'symlink') { fs.renameSync(filename, filename + '.original'); fs.symlinkSync(filename + '.original', filename); }
      else if (mode === 'hardlink') fs.linkSync(filename, filename + '.alias');
      else if (mode === 'generation') {
        const marker = path.join(root, '.ponderosa-layout-version');
        const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
        fs.writeFileSync(marker, JSON.stringify({ ...data, generationId: randomUUID() }));
      }
    }
    return count;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => admitDataDirectory(root, 'ponderosa.db', undefined,
      mode === 'expected' ? { generationId: randomUUID() } : undefined), error => {
      refusal = error.message;
      return /unsupported or incomplete current state/u.test(error.message);
    });
  } finally {
    armed = false; fs.readSync = originalRead; fs.fstatSync = originalFstat; fs.lstatSync = originalLstat;
    syncBuiltinESMExports();
  }
  // A failed admission must not leave an unpublished database/lease authority.
  const authority = new DataDirectoryAuthority(root);
  authority.close();
  const fixtureDescriptors = fs.readdirSync('/proc/self/fd').filter(fd => {
    try { const name = fs.readlinkSync('/proc/self/fd/' + fd); return name === root || name.startsWith(root + '/'); }
    catch { return false; }
  }).length;
  assert.equal(fixtureDescriptors, 0, 'failed admission must release all source and authority handles');
  const result = { triggered, refusal, authorityReleased: true, fixtureDescriptors };
  if (mode === 'readonly-race') {
    const retry = admitDataDirectory(root);
    try { assert.equal(retry.generationId, generation); result.retry = 'admitted'; }
    finally { retry.close(); }
  }
  console.log(JSON.stringify(result));
}
