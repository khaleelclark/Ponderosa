import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createNetServer } from 'node:net';
import { statSync, existsSync } from 'node:fs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const install = process.env.PONDEROSA_TEST_INSTALL_ROOT;
const server = install ? path.join(install, 'app/server') : path.join(repository, 'apps/server');
const launcher = install ? path.join(install, 'app/launcher/dist') : path.join(repository, 'apps/launcher/dist');
const native = install ? path.dirname(createRequire(path.join(server, 'package.json')).resolve('@ponderosa/native-host'))
  : path.join(repository, 'packages/native-host/dist');
const nativeUrl = pathToFileURL(path.join(native, 'index.js')).href;
const fsUrl = pathToFileURL(path.join(native, 'fs.js')).href;
const { DataDirectoryAuthority, DataDirectoryReadReference, physicalDirectoryIdentity } = await import(nativeUrl);
const heldFs = await import(fsUrl);
const { createServer } = await import(pathToFileURL(path.join(server, 'dist/app.js')));
const { resolveLauncherPaths, hostPlatformAdapter, currentPonderosaStatus, stopPonderosa } = await import(pathToFileURL(path.join(launcher, 'index.js')));
const { withLocalLauncherAuthority } = await import(pathToFileURL(path.join(launcher, 'control.js')));

const windows = { skip: process.platform !== 'win32' ? 'Windows retained directory reopen regression' : false };
const normalLocation = process.env.LOCALAPPDATA ?? os.tmpdir();

test('Windows retained-root listings have independent cursors and never follow a replacement or reparse point', windows, t => {
  const root = mkdtempSync(path.join(normalLocation, 'ponderosa-retained-root-'));
  let authority, nested, reference, first, second, passed = false;
  try {
    const directory = path.join(root, 'held'), outside = path.join(root, 'outside');
    mkdirSync(directory); mkdirSync(outside);
    mkdirSync(path.join(directory, 'child'));
    writeFileSync(path.join(directory, 'child', 'nested.txt'), 'nested');
    writeFileSync(path.join(outside, 'secret.txt'), 'outside sentinel');
    const names = Array.from({ length: 512 }, (_, i) => `${String(i).padStart(4, '0')}-${'entry'.repeat(15)}.txt`);
    for (const name of names) writeFileSync(path.join(directory, name), name);
    symlinkSync(outside, path.join(directory, 'escape'), 'junction');
    authority = new DataDirectoryAuthority(directory);
    const held = authority.rootPath, identity = physicalDirectoryIdentity(held);
    assert.throws(() => new DataDirectoryAuthority(directory), /owned/);
    const expected = [...names, 'escape', 'child'].sort();
    first = heldFs.opendirSync(held); second = heldFs.opendirSync(held);
    const a = [], b = [];
    for (let i = 0; i < expected.length; i++) {
      a.push(first.readSync()?.name);
      if (i === 3) assert.deepEqual(heldFs.readdirSync(held).sort(), expected);
      b.push(second.readSync()?.name);
    }
    assert.equal(first.readSync(), null); assert.equal(second.readSync(), null);
    assert.deepEqual(a.sort(), expected); assert.deepEqual(b.sort(), expected);
    assert.deepEqual(heldFs.readdirSync(held).sort(), expected);
    assert.equal(heldFs.readdirSync(held, { withFileTypes: true }).find(e => e.name === 'escape').isSymbolicLink(), true);
    assert.throws(() => heldFs.readFileSync(path.join(held, 'escape', 'secret.txt')));
    assert.equal(physicalDirectoryIdentity(held), identity);
    first.closeSync(); first = undefined; second.closeSync(); second = undefined;
    // This root was acquired through NtCreateFile, not a pathname CreateFile.
    nested = new DataDirectoryAuthority(path.join(held, 'child'));
    assert.deepEqual(heldFs.readdirSync(nested.rootPath), ['nested.txt']);
    nested.close(); nested = undefined;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DataDirectoryAuthority } from ${JSON.stringify(nativeUrl)};
      import { readdirSync } from ${JSON.stringify(fsUrl)};
      const owner = new DataDirectoryAuthority(process.argv[1], 4, JSON.parse(process.argv[2]));
      try { process.stdout.write(JSON.stringify(readdirSync(owner.rootPath).sort())); }
      finally { owner.close(); }
    `, held, JSON.stringify(authority.exportLeaseTransfer())],
    { stdio: ['ignore', 'pipe', 'pipe', 'ignore', authority.exportDescriptor()], encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.deepEqual(JSON.parse(child.stdout), expected);
    authority.close(); authority = undefined;
    assert.throws(() => heldFs.readdirSync(held));
    reference = new DataDirectoryReadReference(directory);
    const pinned = reference.rootPath;
    renameSync(directory, directory + '-moved');
    mkdirSync(directory); writeFileSync(path.join(directory, 'replacement.txt'), 'must not appear');
    assert.deepEqual(heldFs.readdirSync(pinned).sort(), expected);
    assert.equal(physicalDirectoryIdentity(pinned), identity);
    assert.throws(() => heldFs.writeFileSync(path.join(pinned, 'forbidden.txt'), 'no read-pin promotion'));
    reference.close(); reference = undefined;
    assert.throws(() => heldFs.readdirSync(pinned));
    assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside sentinel');
    passed = true;
  } finally {
    first?.closeSync(); second?.closeSync(); nested?.close(); reference?.close(); authority?.close();
    if (passed) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Failed retained-root fixture preserved: ${root}`);
  }
});

test('Windows launcher admits existing current state through its retained parent without changing configuration or canonical content', windows, async t => {
  const root = mkdtempSync(path.join(normalLocation, 'ponderosa-existing-startup-'));
  const dataDir = path.join(root, 'normal'), applicationData = path.join(dataDir, 'data');
  let app, passed = false;
  try {
    mkdirSync(path.join(dataDir, 'config'), { recursive: true });
    const config = path.join(dataDir, 'config', 'launcher.json');
    const configBytes = JSON.stringify({ port: 9787 }); writeFileSync(config, configBytes);
    app = createServer({ dataDir: applicationData, logger: false, engines: [], allowedBrowseRoots: [root] });
    await app.ready(); app.prepareForShutdown(); await app.close(); app = undefined;
    const canonical = path.join(applicationData, 'workspace-instance-id');
    const before = readFileSync(canonical);
    const paths = resolveLauncherPaths({ platform: hostPlatformAdapter(), dataDir,
      installRoot: install ?? repository });
    // Only the actual state-admission entry is needed for this local phase.
    paths.serverEntry = path.join(server, 'dist/main.js');
    for (let i = 0; i < 2; i++) await withLocalLauncherAuthority(paths, held => {
      assert.ok(heldFs.readdirSync(held.dataDir).includes('data'));
      assert.ok(heldFs.readdirSync(held.applicationDataDir).includes('ponderosa.db'));
      assert.equal(heldFs.readFileSync(path.join(held.configDir, 'launcher.json'), 'utf8'), configBytes);
      assert.deepEqual(heldFs.readFileSync(path.join(held.applicationDataDir, 'workspace-instance-id')), before);
    });
    assert.equal(readFileSync(config, 'utf8'), configBytes);
    assert.deepEqual(readFileSync(canonical), before);
    passed = true;
  } finally {
    if (app) { app.prepareForShutdown(); await app.close(); }
    if (passed) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Failed existing-state startup fixture preserved: ${root}`);
  }
});

test('Windows production engine IPC starts and reopens existing disposable state with exact child transfer and graceful cleanup', { ...windows, timeout: 120000 }, async t => {
  const root = mkdtempSync(path.join(normalLocation, 'ponderosa-engine-startup-'));
  const dataDir = path.join(root, 'normal'), applicationData = path.join(dataDir, 'data');
  let app, child, exited, passed = false;
  let fixtureInstall = install;
  try {
    if (!fixtureInstall) {
      fixtureInstall = path.join(root, 'install');
      mkdirSync(path.join(fixtureInstall, 'runtime'), { recursive: true });
      mkdirSync(path.join(fixtureInstall, 'app/web'), { recursive: true });
      symlinkSync(process.execPath, path.join(fixtureInstall, 'runtime/node.exe'));
      symlinkSync(server, path.join(fixtureInstall, 'app/server'), 'junction');
      symlinkSync(path.join(repository, 'apps/web/dist'), path.join(fixtureInstall, 'app/web/dist'), 'junction');
      writeFileSync(path.join(fixtureInstall, 'build-manifest.json'), JSON.stringify({
        schemaVersion: 1, product: 'Ponderosa', version: '0.1.0-test', commit: 'a'.repeat(40),
        communicationProtocolVersion: 'communication-v3', databaseSchemaVersion: '0000_state_epoch_2.sql', databaseSchemaSha256: 'b'.repeat(64),
        target: { platform: process.platform, arch: process.arch }, nodeVersion: process.version,
        nodeExecutableBytes: statSync(process.execPath).size, nodeExecutableSha256: 'c'.repeat(64),
        nodeSource: { url: 'https://nodejs.org/test-fixture', archiveSha256: 'd'.repeat(64), executableSha256: 'c'.repeat(64) },
        nativeAbi: { modules: process.versions.modules, napi: process.versions.napi }, nativeHost: { bytes: 1, sha256: 'e'.repeat(64) },
        buildTime: new Date().toISOString(), channel: 'development',
      }));
    }
    const net = createNetServer();
    await new Promise((resolve, reject) => { net.once('error', reject); net.listen(0, '127.0.0.1', resolve); });
    const port = net.address().port; await new Promise(resolve => net.close(resolve));
    mkdirSync(path.join(dataDir, 'config'), { recursive: true });
    const configuration = JSON.stringify({ port, providers: {
      codex: { executable: path.join(root, 'absent-codex.exe') }, claude: { executable: path.join(root, 'absent-claude.exe') },
    } });
    writeFileSync(path.join(dataDir, 'config/launcher.json'), configuration);
    app = createServer({ dataDir: applicationData, logger: false, engines: [], allowedBrowseRoots: [root] });
    await app.ready(); app.prepareForShutdown(); await app.close(); app = undefined;
    const identityFile = path.join(applicationData, 'workspace-instance-id'), identity = readFileSync(identityFile);
    const paths = resolveLauncherPaths({ platform: hostPlatformAdapter(), dataDir, installRoot: fixtureInstall });
    for (let attempt = 0; attempt < 2; attempt++) {
      let output = '';
      child = spawn(process.execPath, [path.join(launcher, 'cli.js'), 'engine', '--install-root', fixtureInstall, '--data-dir', dataDir, '--no-browser'], {
        cwd: fixtureInstall, env: { ...process.env, PONDEROSA_ENGINE_PARENT_PID: String(process.pid) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      });
      child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      exited = new Promise(resolve => child.once('exit', code => resolve(code)));
      let status;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && child.exitCode === null) {
        status = await currentPonderosaStatus(paths);
        if (status?.healthy) break;
        await delay(100);
      }
      assert.equal(status?.healthy, true, output);
      assert.equal(status.stateEpoch, 2); assert.ok(status.stateGenerationId);
      assert.deepEqual(readFileSync(identityFile), identity);
      assert.equal(readFileSync(path.join(dataDir, 'config/launcher.json'), 'utf8'), configuration);
      child.send({ type: 'ponderosa-engine-stop' });
      const code = await Promise.race([exited, delay(30000, undefined, { ref: false }).then(() => 'shutdown-timeout')]);
      assert.equal(code, 0, output);
      assert.equal(await currentPonderosaStatus(paths), undefined);
      assert.equal(existsSync(paths.engineSupervisorPath), false);
      child = undefined;
    }
    passed = true;
  } finally {
    if (app) { app.prepareForShutdown(); await app.close(); }
    if (child?.exitCode === null) {
      if (child.connected) child.send({ type: 'ponderosa-engine-stop' });
      const drained = await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => 'cleanup-timeout')]);
      if (drained === 'cleanup-timeout') {
        await stopPonderosa({ paths: resolveLauncherPaths({ platform: hostPlatformAdapter(), dataDir, installRoot: fixtureInstall }) });
        assert.equal(await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => 'cleanup-timeout')]), 0, 'Owned engine did not drain');
      }
    }
    if (passed) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Failed production-engine startup fixture preserved: ${root}`);
  }
});
