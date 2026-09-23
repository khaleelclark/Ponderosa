import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    ensureCurrentDataLayout(ownership.dataDir);
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

test("replacing the diagnostic lock cannot steal a live kernel lease", () => {
  const directory = temporaryDataDirectory();
  const lockPath = join(directory, ".ponderosa-daemon.lock");
  const ownership = acquireDataDirectoryOwnership(directory);
  try {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, token: "replacement" }));
    assert.throws(
      () => acquireDataDirectoryOwnership(directory),
      /already owned by another Ponderosa process/u,
    );
  } finally {
    releaseDataDirectoryOwnership(ownership);
  }
});

test("ignores a stale diagnostic lock when the kernel lease is free", () => {
  const directory = temporaryDataDirectory();
  writeFileSync(join(directory, ".ponderosa-daemon.lock"), JSON.stringify({
    pid: 999_999,
    token: "stale-owner",
  }));

  const ownership = acquireDataDirectoryOwnership(directory);
  try {
    assert.equal(ownership.dataDir.includes("/fd/"), true);
  } finally {
    releaseDataDirectoryOwnership(ownership);
  }
});

test("ancestor replacement cannot redirect an open store", () => {
  const parent = temporaryDataDirectory();
  const directory = join(parent, "data");
  const retained = join(parent, "retained-data");
  mkdirSync(directory);
  const opened = openAgentStoreData(directory);
  try {
    renameSync(directory, retained);
    mkdirSync(directory);
    writeFileSync(opened.deliverySequenceFile, '{"sequence":7}\n', { flag: "a" });
    assert.match(readFileSync(join(retained, "delivery-order.jsonl"), "utf8"), /"sequence":7/u);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    opened.client.close();
    releaseDataDirectoryOwnership(opened.ownership);
  }
});
