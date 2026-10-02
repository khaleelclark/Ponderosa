import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";
import { dbPath } from "../dist/paths.js";

test("exact injection migration preserves historical hashes without inventing text; new packets remain immutable and attributed", () => {
  const directory = mkdtempSync(join(tmpdir(), "prompt-injection-migration-")); let store = new AgentStore(directory);
  try {
    let c = new CoordinationV3Store(store.sqlite);
    const p = store.createProject({ label: "Synthetic", hostPath: directory, defaultEngine: "codex" });
    const chat = store.createConversation(p.id, { title: "Synthetic" });
    const agent = store.createAgent(p.id, { title: "Synthetic", engine: "codex", conversationId: chat.id });
    const coordinate = id => c.coordinate({ projectId: p.id, conversationId: chat.id, actorScope: "user:local-operator", idempotencyKey: id, requests: [{ requestId: id, recipientAgentId: agent.id, lifetime: { kind: "indefinite" }, payload: {} }] });
    coordinate("historical"); const historical = c.leaseNextRun({ workerId: "synthetic" });
    const injection = { injectionId: historical.injectionId, runId: historical.runId, fencingToken: historical.fencingToken };
    c.preparePromptInjection({ ...injection, prompt: "Historical text must not be reconstructed" }); c.markPromptSubmitted(injection); c.acknowledgePromptInjection(injection); c.completeRun(historical.runId, historical.fencingToken);
    // sqlite.name may be rooted through an owned /proc/self/fd descriptor on
    // Linux. After store.close(), reopen only the stable disposable fixture path.
    const file = dbPath(directory); const original = store.sqlite.prepare("SELECT prompt_hash,state FROM scheduler_prompt_injections WHERE id=?").get(historical.injectionId);
    store.close();
    const legacy = new Database(file); legacy.exec("ALTER TABLE scheduler_prompt_injections DROP COLUMN exact_prompt; ALTER TABLE scheduler_prompt_injections DROP COLUMN source_manifest_json; DELETE FROM _schema_version WHERE name='0017_exact_prompt_injections.sql'"); legacy.close();
    store = new AgentStore(directory); c = new CoordinationV3Store(store.sqlite);
    assert.deepEqual(store.sqlite.prepare("SELECT prompt_hash,state,exact_prompt,source_manifest_json FROM scheduler_prompt_injections WHERE id=?").get(historical.injectionId), { ...original, exact_prompt: null, source_manifest_json: null });
    coordinate("new"); const next = c.leaseNextRun({ workerId: "synthetic" }); const prompt = "Exact new instructions";
    c.preparePromptInjection({ injectionId: next.injectionId, runId: next.runId, fencingToken: next.fencingToken, prompt });
    const row = store.sqlite.prepare("SELECT prompt_hash,exact_prompt,source_manifest_json FROM scheduler_prompt_injections WHERE id=?").get(next.injectionId);
    assert.equal(row.exact_prompt, prompt); assert.equal(row.prompt_hash, createHash("sha256").update(prompt).digest("hex"));
    const manifest = JSON.parse(row.source_manifest_json); assert.equal(manifest.runId, next.runId); assert.equal(manifest.injectionId, next.injectionId); assert.deepEqual(manifest.activationIds, next.activationIds);
    assert.throws(() => c.preparePromptInjection({ injectionId: next.injectionId, runId: next.runId, fencingToken: next.fencingToken, prompt: "changed" }), /payload changed/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
