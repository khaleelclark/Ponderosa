import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createLauncherSecurity } from "../dist/launcher-security.js";

test("browser sessions renew on use and survive a server restart", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-session-"));
  let firstDb;
  let secondDb;
  t.after(() => {
    if (firstDb?.open) firstDb.close();
    secondDb?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const filename = path.join(root, "state.sqlite");
  let now = 1_700_000_000_000;
  const opts = {
    dataDir: root,
    engines: [],
    launcherSecurity: { controlToken: "launcher-secret", sessionTtlMs: 60_000 },
  };
  firstDb = new Database(filename);
  const first = createLauncherSecurity(opts, firstDb, () => now);
  const token = first.issueLauncherSession();
  const cookie = `ponderosa_session=${token}`;
  const stored = firstDb.prepare("SELECT token_digest FROM launcher_browser_sessions").get();
  assert.notEqual(stored.token_digest, token);
  assert.equal(first.validLauncherSession(cookie), true);

  now += 31_000;
  const renewals = [];
  assert.equal(first.validLauncherSession(cookie, (value, maxAge) => renewals.push([value, maxAge])), true);
  assert.deepEqual(renewals, [[token, 60]]);
  firstDb.close();

  secondDb = new Database(filename);
  const second = createLauncherSecurity({
    ...opts,
    launcherSecurity: { ...opts.launcherSecurity, controlToken: "new-launcher-secret" },
  }, secondDb, () => now);
  now += 30_000;
  assert.equal(second.validLauncherSession(cookie), true);
  assert.equal(second.validLauncherSession("ponderosa_session=invalid"), false);
  now += 31_000;
  assert.equal(second.validLauncherSession(cookie), false);
});

test("the default browser session outlives an idle overnight tab", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let now = 1_700_000_000_000;
  const security = createLauncherSecurity({
    dataDir: "/tmp/unused",
    engines: [],
    launcherSecurity: { controlToken: "launcher-secret" },
  }, db, () => now);
  assert.equal(security.launcherSessionTtlMs, 30 * 24 * 60 * 60_000);
  const cookie = `ponderosa_session=${security.issueLauncherSession()}`;
  now += 13 * 60 * 60_000;
  assert.equal(security.validLauncherSession(cookie), true);
});

test("rotating the reverse-proxy credential revokes its existing browser sessions", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const opts = {
    dataDir: "/tmp/unused",
    engines: [],
    authToken: "first-backend-secret",
    networkSecurity: { mode: "reverse_proxy", bindHost: "127.0.0.1", authenticationRequired: true, detail: "test" },
  };
  const first = createLauncherSecurity(opts, db);
  const cookie = `__Host-ponderosa_session=${first.issueLauncherSession()}`;
  assert.equal(first.validLauncherSession(cookie), true);
  const rotated = createLauncherSecurity({ ...opts, authToken: "replacement-backend-secret" }, db);
  assert.equal(rotated.validLauncherSession(cookie), false);
});

test("browser session expiry is rolling only when a refreshed cookie can be returned", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let now = 1_700_000_000_000;
  const security = createLauncherSecurity({
    dataDir: "/tmp/unused",
    engines: [],
    launcherSecurity: { controlToken: "launcher-secret", sessionTtlMs: 60_000 },
  }, db, () => now);
  const token = security.issueLauncherSession();
  now += 31_000;
  assert.equal(security.validLauncherSession(`ponderosa_session=${token}`), true);
  now += 30_000;
  assert.equal(security.validLauncherSession(`ponderosa_session=${token}`), false);
});
