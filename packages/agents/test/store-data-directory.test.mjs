import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  acquireDataDirectoryOwnership,
  ensureCurrentDataLayout,
  releaseDataDirectoryOwnership,
} from "../dist/store-data-directory.js";
import { openAgentStoreData } from "../dist/store-component-factory.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDataDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-data-layout-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("initializes a fresh owned data directory", () => {
  const directory = temporaryDataDirectory();
  const ownership = acquireDataDirectoryOwnership(directory);
  try {
    ensureCurrentDataLayout(directory);
    assert.equal(readFileSync(join(directory, ".ponderosa-layout-version"), "utf8"), "1\n");
  } finally {
    releaseDataDirectoryOwnership(ownership);
  }
});

test("preserves and rejects an unmarked nonempty data directory", () => {
  const directory = temporaryDataDirectory();
  const canonicalData = join(directory, "workspace-events.jsonl");
  writeFileSync(canonicalData, '{"important":true}\n', "utf8");
  assert.throws(
    () => openAgentStoreData(directory),
    /nonempty but has no layout marker/u,
  );
  assert.equal(readFileSync(canonicalData, "utf8"), '{"important":true}\n');

  // A failed layout check must release the production ownership lock.
  const ownership = acquireDataDirectoryOwnership(directory);
  try {
    assert.equal(readFileSync(canonicalData, "utf8"), '{"important":true}\n');
  } finally {
    releaseDataDirectoryOwnership(ownership);
  }
});

test("preserves and rejects an unknown data layout", () => {
  const directory = temporaryDataDirectory();
  const canonicalData = join(directory, "workspace-events.jsonl");
  writeFileSync(join(directory, ".ponderosa-layout-version"), "2\n", "utf8");
  writeFileSync(canonicalData, '{"important":true}\n', "utf8");
  const ownership = acquireDataDirectoryOwnership(directory);
  try {
    assert.throws(
      () => ensureCurrentDataLayout(directory),
      /unsupported Ponderosa data layout version: 2/u,
    );
    assert.equal(readFileSync(canonicalData, "utf8"), '{"important":true}\n');
  } finally {
    releaseDataDirectoryOwnership(ownership);
  }
});

test("does not steal an incompletely published lock from a live initializer", async () => {
  const directory = temporaryDataDirectory();
  const lockPath = join(directory, ".ponderosa-daemon.lock");
  const initializer = spawn(process.execPath, ["-e", `
    const { closeSync, openSync, writeFileSync } = require("node:fs");
    const descriptor = openSync(process.argv[1], "wx", 0o600);
    writeFileSync(descriptor, "{");
    process.send("ready");
    process.on("message", () => {
      closeSync(descriptor);
      process.exit(0);
    });
  `, lockPath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  try {
    await once(initializer, "message");
    assert.throws(
      () => acquireDataDirectoryOwnership(directory),
      /incomplete or malformed; refusing to replace/u,
    );
    assert.equal(readFileSync(lockPath, "utf8"), "{");
    assert.equal(initializer.exitCode, null);
  } finally {
    initializer.send("close");
    await once(initializer, "exit");
    rmSync(lockPath, { force: true });
  }
});

test("recovers an atomically published lock after its owner exits", async () => {
  const directory = temporaryDataDirectory();
  const exitedOwner = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const stalePid = exitedOwner.pid;
  await once(exitedOwner, "exit");
  writeFileSync(join(directory, ".ponderosa-daemon.lock"), JSON.stringify({
    pid: stalePid,
    token: "stale-owner",
  }));

  const ownership = acquireDataDirectoryOwnership(directory);
  try {
    const current = JSON.parse(readFileSync(ownership.path, "utf8"));
    assert.equal(current.pid, process.pid);
    assert.equal(current.token, ownership.token);
  } finally {
    releaseDataDirectoryOwnership(ownership);
  }
});
