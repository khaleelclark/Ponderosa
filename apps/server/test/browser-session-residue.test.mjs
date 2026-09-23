import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processBirthMarker } from "@ponderosa/engines";
import {
  browserResidueCleanupStatus,
  recoverBrowserResidue,
  recoverHostedDisplayResidue,
} from "../dist/browser-session-residue.js";

async function unixSocket(pathname) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pathname, resolve);
  });
  return server;
}

function age(pathname) {
  const old = new Date(Date.now() - 60_000);
  utimesSync(pathname, old, old);
}

test("browser startup quarantines stale session state and drains all residue", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-browser-residue-"));
  const sessions = join(dataDir, "browser-sessions");
  const earlierRecovery = sessions + ".recovery-12345678-1234-4234-8234-123456789abc";

  try {
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "stale-profile"), "stale", "utf8");
    mkdirSync(earlierRecovery, { recursive: true });
    writeFileSync(join(earlierRecovery, "older-profile"), "older", "utf8");

    await recoverBrowserResidue(dataDir);

    assert.deepEqual(readdirSync(sessions), []);
    assert.equal(existsSync(join(sessions, "stale-profile")), false);

    const deadline = Date.now() + 2_000;
    while (browserResidueCleanupStatus(dataDir).pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(browserResidueCleanupStatus(dataDir), { pending: 0, failed: 0 });
    assert.deepEqual(readdirSync(dataDir), ["browser-sessions"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("browser startup safely removes legacy Ponderosa Xvfb artifacts whose recorded process is dead", async () => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-xvfb-residue-"));
  const sockets = join(root, "sockets");
  const displayNumber = 553;
  const reservation = join(root, `ponderosa-xvfb-${displayNumber}.lock`);
  const xLock = join(root, `.X${displayNumber}-lock`);
  const socket = join(sockets, `X${displayNumber}`);
  mkdirSync(sockets);
  writeFileSync(reservation, "", { mode: 0o600 });
  writeFileSync(xLock, "2147483647\n", { mode: 0o600 });
  const server = await unixSocket(socket);
  age(reservation);
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: sockets,
      minimumAgeMs: 0,
    });
    assert.equal(existsSync(reservation), false);
    assert.equal(existsSync(xLock), false);
    assert.equal(existsSync(socket), false);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser startup preserves a legacy Xvfb reservation while its lock PID is alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-xvfb-live-"));
  const sockets = join(root, "sockets");
  const displayNumber = 736;
  const reservation = join(root, `ponderosa-xvfb-${displayNumber}.lock`);
  const xLock = join(root, `.X${displayNumber}-lock`);
  const socket = join(sockets, `X${displayNumber}`);
  mkdirSync(sockets);
  writeFileSync(reservation, "", { mode: 0o600 });
  writeFileSync(xLock, `${process.pid}\n`, { mode: 0o600 });
  const server = await unixSocket(socket);
  age(reservation);
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: sockets,
      minimumAgeMs: 0,
    });
    assert.equal(existsSync(reservation), true);
    assert.equal(existsSync(xLock), true);
    assert.equal(existsSync(socket), true);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser startup terminates a live orphan only when its durable process identity matches', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-owned-orphan-'));
  const sockets = join(root, 'sockets');
  const displayNumber = 812;
  const reservation = join(root, `ponderosa-xvfb-${displayNumber}.lock`);
  const xLock = join(root, `.X${displayNumber}-lock`);
  const socket = join(sockets, `X${displayNumber}`);
  mkdirSync(sockets);
  const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  assert.ok(child.pid);
  const birthMarker = processBirthMarker(child.pid);
  assert.ok(birthMarker);
  writeFileSync(reservation, JSON.stringify({
    schemaVersion: 1,
    displayNumber,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    owner: { pid: 2147483647, pgid: 2147483647, birthMarker: 'dead:owner' },
    xvfb: { pid: child.pid, pgid: child.pid, birthMarker },
  }), { mode: 0o600 });
  writeFileSync(xLock, `${child.pid}\n`, { mode: 0o600 });
  const server = await unixSocket(socket);
  age(reservation);
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: sockets,
      minimumAgeMs: 0,
    });
    assert.equal(existsSync(reservation), false);
    assert.equal(existsSync(xLock), false);
    assert.equal(existsSync(socket), false);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser startup retains authority until a recorded live orphan exits even when X artifacts are absent', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-owned-no-artifacts-'));
  const displayNumber = 818;
  const reservation = join(root, `ponderosa-xvfb-${displayNumber}.lock`);
  const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  assert.ok(child.pid);
  const birthMarker = processBirthMarker(child.pid);
  assert.ok(birthMarker);
  writeFileSync(reservation, JSON.stringify({
    schemaVersion: 1,
    displayNumber,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    owner: { pid: 2147483647, pgid: 2147483647, birthMarker: 'dead:owner' },
    xvfb: { pid: child.pid, pgid: child.pid, birthMarker },
  }), { mode: 0o600 });
  age(reservation);
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: root,
      minimumAgeMs: 0,
    });
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(reservation), false);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser startup refuses cleanup when an Xvfb PID has been reused', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-reused-pid-'));
  const sockets = join(root, 'sockets');
  const displayNumber = 813;
  const reservation = join(root, `ponderosa-xvfb-${displayNumber}.lock`);
  const xLock = join(root, `.X${displayNumber}-lock`);
  const socket = join(sockets, `X${displayNumber}`);
  mkdirSync(sockets);
  const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  assert.ok(child.pid);
  writeFileSync(reservation, JSON.stringify({
    schemaVersion: 1,
    displayNumber,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    owner: { pid: 2147483647, pgid: 2147483647, birthMarker: 'dead:owner' },
    xvfb: { pid: child.pid, pgid: child.pid, birthMarker: 'stale:birth' },
  }), { mode: 0o600 });
  writeFileSync(xLock, `${child.pid}\n`, { mode: 0o600 });
  const server = await unixSocket(socket);
  age(reservation);
  try {
    await assert.rejects(recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: sockets,
      minimumAgeMs: 0,
    }), /PID .* was reused/);
    process.kill(child.pid, 0);
    assert.equal(existsSync(reservation), true);
    assert.equal(existsSync(xLock), true);
    assert.equal(existsSync(socket), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser startup never signals a forged Xvfb process group', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-forged-pgid-'));
  const sockets = join(root, 'sockets');
  const displayNumber = 817;
  const reservation = join(root, `ponderosa-xvfb-${displayNumber}.lock`);
  const xLock = join(root, `.X${displayNumber}-lock`);
  const socket = join(sockets, `X${displayNumber}`);
  mkdirSync(sockets);
  const child = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  assert.ok(child.pid);
  const birthMarker = processBirthMarker(child.pid);
  assert.ok(birthMarker);
  writeFileSync(reservation, JSON.stringify({
    schemaVersion: 1,
    displayNumber,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    owner: { pid: 2147483647, pgid: 2147483647, birthMarker: 'dead:owner' },
    xvfb: { pid: child.pid, pgid: process.pid, birthMarker },
  }), { mode: 0o600 });
  writeFileSync(xLock, `${child.pid}\n`, { mode: 0o600 });
  const server = await unixSocket(socket);
  age(reservation);
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: sockets,
      minimumAgeMs: 0,
    });
    process.kill(child.pid, 0);
    assert.equal(existsSync(reservation), true);
    assert.equal(existsSync(xLock), true);
    assert.equal(existsSync(socket), true);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser startup reports but never follows a forged reservation symlink', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-symlink-'));
  const target = join(root, 'must-survive');
  const reservation = join(root, 'ponderosa-xvfb-814.lock');
  writeFileSync(target, 'foreign', { mode: 0o600 });
  symlinkSync(target, reservation);
  try {
    await assert.rejects(recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: root,
      minimumAgeMs: 0,
    }), /refusing to remove unowned file artifact/);
    assert.equal(existsSync(reservation), true);
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser residue status forgets a failed display after an external correction removes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-reconciled-'));
  const dataDir = join(root, 'data');
  const target = join(root, 'must-survive');
  const reservation = join(root, 'ponderosa-xvfb-815.lock');
  mkdirSync(dataDir);
  writeFileSync(target, 'foreign', { mode: 0o600 });
  symlinkSync(target, reservation);
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: root,
      minimumAgeMs: 0,
      trackStatus: true,
    });
    assert.equal(browserResidueCleanupStatus(dataDir).failed, 1);

    rmSync(reservation);
    rmSync(target);
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: root,
      minimumAgeMs: 0,
      trackStatus: true,
    });
    assert.equal(browserResidueCleanupStatus(dataDir).failed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh dead display residue remains pending and is retried after its safety window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ponderosa-xvfb-young-'));
  const dataDir = join(root, 'data');
  const reservation = join(root, 'ponderosa-xvfb-816.lock');
  mkdirSync(dataDir);
  writeFileSync(reservation, '', { mode: 0o600 });
  try {
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: root,
      minimumAgeMs: 50,
      trackStatus: true,
    });
    assert.equal(existsSync(reservation), true);
    assert.equal(browserResidueCleanupStatus(dataDir).pending, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await recoverHostedDisplayResidue({
      reservationDirectory: root,
      xLockDirectory: root,
      socketDirectory: root,
      minimumAgeMs: 50,
      trackStatus: true,
    });
    assert.equal(existsSync(reservation), false);
    assert.equal(browserResidueCleanupStatus(dataDir).pending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
