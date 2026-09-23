import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/index.js";
import { projectionSourceFingerprint } from "../dist/projection-checkpoint.js";

test("clean shutdown checkpoint is one-shot and missing markers force recovery", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-projection-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new AgentStore(root);
  store.createProject({ label: "Checkpoint", hostPath: root, defaultEngine: "codex" });
  assert.equal(store.startupProfile().mode, "recovery");
  store.close();
  const marker = path.join(root, ".projection-clean-shutdown.json");
  assert.equal(existsSync(marker), false, "an unqualified writing process cannot mint a clean checkpoint");

  store = new AgentStore(root);
  assert.equal(store.startupProfile().mode, "recovery");
  store.close();
  assert.equal(existsSync(marker), true);

  store = new AgentStore(root);
  assert.equal(store.startupProfile().mode, "clean");
  assert.equal(existsSync(marker), false, "startup consumes the crash fence before serving");
  store.close();
  rmSync(marker, { force: true });
  store = new AgentStore(root);
  assert.equal(store.startupProfile().mode, "recovery");
  store.close();
});

test("qualified orderly shutdown checkpoints a write-active lifetime", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-projection-orderly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new AgentStore(root);
  store.createProject({ label: "Checkpoint", hostPath: root, defaultEngine: "codex" });
  store.close({ checkpointWrites: true });
  store = new AgentStore(root);
  assert.equal(store.startupProfile().mode, "clean");
  assert.equal(store.listProjects().length, 1);
  store.close();
});

test("clean projection fingerprinting does not read multi-gigabyte histories", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-projection-large-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = path.join(root, "large-history.jsonl");
  writeFileSync(history, "{}\n");
  truncateSync(history, 3 * 1024 * 1024 * 1024);
  const started = performance.now();
  assert.match(projectionSourceFingerprint(root), /^[0-9a-f]{64}$/u);
  assert.ok(performance.now() - started < 5_000, "fingerprinting should inspect metadata, not sparse contents");
});

test("canonical changes invalidate a clean shutdown checkpoint", t => {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-projection-checkpoint-change-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new AgentStore(root);
  const project = store.createProject({ label: "Checkpoint", hostPath: root, defaultEngine: "codex" });
  store.close();
  store = new AgentStore(root);
  assert.equal(store.startupProfile().mode, "recovery");
  store.close();
  const record = path.join(root, "projects", project.id, "project.json");
  const current = JSON.parse(readFileSync(record, "utf8"));
  writeFileSync(record, `${JSON.stringify({ ...current, label: "Changed while stopped" })}\n`);
  store = new AgentStore(root);
  assert.equal(store.startupProfile().mode, "recovery");
  store.close();
});
