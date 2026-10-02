import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "public-progress-"));
  const store = new AgentStore(root), coordination = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({ label: "Fixture", hostPath: root, defaultEngine: "codex" });
  const chat = store.createConversation(project.id, { title: "Chat" });
  const agent = store.createAgent(project.id, { title: "Boston", engine: "codex", conversationId: chat.id });
  const now = () => new Date().toISOString();
  const record = (id, policy = "next_run") => {
    const communication = { eventId: id, schemaVersion: 2, projectId: project.id, conversationId: chat.id,
      sender: { kind: "user", userId: "operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "operator", agentId: agent.id }, text: id, createdAt: now() };
    return coordination.recordRuntimeCommunication({ id, projectId: project.id, sender: communication.sender,
      intent: communication.intent, audience: communication.audience,
      payload: { communication, dispatch: { conversationId: chat.id, text: id, activeRunDelivery: "steer",
        recipients: [{ agentId: agent.id, attachments: [] }] } },
      activation: { agentId: agent.id, kind: "human_message", priority: 100, dispatchPolicy: policy, promptClass: "human" }, now: communication.createdAt });
  };
  const acknowledge = lease => {
    coordination.preparePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, prompt: "work", now: now() });
    coordination.markPromptSubmitted({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, now: now() });
    coordination.acknowledgePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, now: now() });
  };
  record("original");
  const lease = coordination.leaseNextRun({ workerId: "fixture", now: now() }); assert.ok(lease);
  coordination.markRunStarted(lease.runId, lease.fencingToken, now());
  coordination.recordProviderInput({ executionId: "execution", schedulerRunId: lease.runId, fencingToken: lease.fencingToken,
    agentId: agent.id, projectId: project.id, prompt: "work", sourceManifest: { schemaVersion: 1, historyMessageCount: 0,
      activationIds: lease.activationIds, communicationEventIds: ["original"], artifactIds: [], conversationId: chat.id,
      providerSessionDisposition: "fresh_task", sources: [] }, now: now() });
  const append = (delta, extra = {}) => store.appendEvent(agent.id, { type: "text", delta, executionId: "execution",
    presentation: "progress", progressInjectionId: lease.injectionId, ...extra }, now());
  const receipt = id => coordination.deliveryReceiptsForCommunications(project.id, [id]).get(id)?.[0];
  return { root, store, coordination, project, chat, agent, lease, record, acknowledge, append, receipt, now,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("public progress is bounded, latest-only, acknowledged, exact-Run scoped, and not Communication", () => {
  const f = fixture();
  try {
    f.append("Early");
    assert.equal(f.receipt("original").liveProgress, undefined, "submission is not acknowledgement");
    f.acknowledge(f.lease);
    f.append("First"); f.append("Latest");
    f.append("PRIVATE REASONING", { type: "reasoning", presentation: undefined });
    f.append("PRIVATE TOOL", { type: "tool_result", id: "tool", output: "private", presentation: undefined });
    f.append("Other Run", { executionId: "other" });
    f.append("No phase", { presentation: undefined });
    assert.equal(f.receipt("original").liveProgress.text, "Latest");
    assert.equal(f.store.getProjectedConversationMessages(f.chat.id, "main").length, 0);
    f.append("😀".repeat(20_000));
    const progress = f.receipt("original").liveProgress;
    assert.equal(Array.from(progress.text).length, 1200); assert.equal(progress.truncated, true);
    const plan = f.store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM events WHERE agent_id=?
      AND json_extract(payload_json,'$.executionId')=? AND json_extract(payload_json,'$.progressInjectionId')=?
      AND type='text' AND json_extract(payload_json,'$.presentation')='progress' ORDER BY seq DESC LIMIT 1`)
      .all(f.agent.id, "execution", f.lease.injectionId);
    assert.match(JSON.stringify(plan), /idx_events_public_progress/);
    assert.deepEqual(f.coordination.deliveryReceiptsForCommunications("foreign-project", ["original"]).get("original"), []);
    f.store.updateAgent(f.agent.id, { title: "Renamed", handle: "Boston-renamed" });
    assert.equal(f.receipt("original").liveProgress.recipientHandle, f.store.getAgent(f.agent.id).handle);
    f.store.updateAgent(f.agent.id, { archived: true });
    assert.equal(f.receipt("original").liveProgress, undefined);
  } finally { f.close(); }
});

test("a pending new steer suppresses old commentary; acknowledgement and newer output are separate", () => {
  const f = fixture();
  try {
    f.acknowledge(f.lease); f.append("Before instructions");
    f.record("steer", "steer_or_run");
    const steer = f.coordination.leaseNextSteering({ workerId: "fixture", now: f.now() }); assert.ok(steer);
    assert.equal(f.receipt("original").liveProgress, undefined);
    assert.equal(f.receipt("steer").providerAcknowledged, undefined);
    f.acknowledge(steer);
    assert.equal(f.receipt("steer").injectionKind, "steer");
    assert.equal(f.receipt("steer").providerAcknowledged, true);
    assert.equal(f.receipt("steer").liveProgress, undefined, "an ack does not invent commentary");
    f.append("Now following the revised plan", { progressInjectionId: steer.injectionId });
    assert.equal(f.receipt("steer").liveProgress.text, "Now following the revised plan");
    assert.equal(f.receipt("original").liveProgress, undefined);
    // A scoped canonical reply, not work-log prose, settles the display.
    const reply = { eventId: "reply", schemaVersion: 2, projectId: f.project.id, conversationId: f.chat.id,
      sender: { kind: "agent", agentId: f.agent.id, executionId: "execution" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "operator", agentId: f.agent.id }, text: "Done", createdAt: f.now() };
    f.coordination.recordRuntimeCommunication({ id: reply.eventId, projectId: f.project.id,
      sender: reply.sender, intent: reply.intent, audience: reply.audience, payload: { communication: reply },
      scopeKey: `conversation:${f.chat.id}`, runAuthorization: { runId: f.lease.runId, fencingToken: f.lease.fencingToken,
        agentId: f.agent.id, projectId: f.project.id }, now: reply.createdAt });
    assert.equal(f.receipt("steer").liveProgress, undefined);
    assert.equal(f.store.readEvents(f.agent.id).filter(e => e.event.presentation === "progress").length, 2);
  } finally { f.close(); }
});

test("terminal or expired Runs cannot keep a live progress card", () => {
  for (const state of ["completed", "failed", "cancelled", "outcome_unknown", "expired"]) {
    const f = fixture();
    try {
      f.acknowledge(f.lease); f.append("Working");
      assert.ok(f.receipt("original").liveProgress);
      if (state === "expired") f.store.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(f.lease.runId);
      else f.store.sqlite.prepare("UPDATE scheduler_runs SET status=? WHERE id=?").run(state, f.lease.runId);
      assert.equal(f.receipt("original").liveProgress, undefined, state);
      assert.equal(f.receipt("original").providerAcknowledged, true, "delivery proof survives");
    } finally { f.close(); }
  }
});

test("coalesced human steering updates appear once, not under every accepted instruction", () => {
  const f = fixture();
  try {
    f.acknowledge(f.lease);
    f.record("steer-one", "steer_or_run"); f.record("steer-two", "steer_or_run");
    const steer = f.coordination.leaseNextSteering({ workerId: "fixture", now: f.now() }); assert.ok(steer);
    assert.equal(steer.activations.length, 2);
    f.acknowledge(steer);
    f.append("One current update", { progressInjectionId: steer.injectionId });
    const receipts = ["original", "steer-one", "steer-two"].map(f.receipt);
    assert.equal(receipts.filter(receipt => receipt.liveProgress).length, 1);
    assert.equal(receipts.filter(receipt => receipt.providerAcknowledged).length, 3);
  } finally { f.close(); }
});

test("a reply before a new steer does not hide its progress, and reopening preserves the Work log", () => {
  const f = fixture();
  try {
    f.acknowledge(f.lease); f.append("First update");
    // Simulate an earlier scoped canonical publication without advancing any
    // scheduler authority. It is not a reply to the later steering injection.
    f.store.sqlite.prepare(`INSERT INTO runtime_communications
      (id,project_id,sender_json,intent,audience_json,payload_json,payload_hash,actionable,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("old-reply", f.project.id,
        JSON.stringify({ kind: "agent", agentId: f.agent.id, executionId: "execution" }), "user_dm", "{}",
        JSON.stringify({ communication: { conversationId: f.chat.id } }), "fixture", 0, "2000-01-01T00:00:00Z");
    f.record("later-steer", "steer_or_run");
    const steer = f.coordination.leaseNextSteering({ workerId: "fixture", now: f.now() }); assert.ok(steer);
    f.acknowledge(steer); f.append("New update", { progressInjectionId: steer.injectionId });
    assert.equal(f.receipt("later-steer").liveProgress.text, "New update");
    f.store.close();
    const reopened = new AgentStore(f.root);
    try {
      const receipt = new CoordinationV3Store(reopened.sqlite)
        .deliveryReceiptsForCommunications(f.project.id, ["later-steer"]).get("later-steer")[0];
      assert.equal(receipt.liveProgress.text, "New update");
      assert.match(reopened.getRunOutputs(f.agent.id).map(item => item.text).join(""), /First update.*New update/s);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("public activity identifies exact open spans, never prose, inputs, completed calls or another Run", () => {
  const f = fixture();
  try {
    f.acknowledge(f.lease);
    f.store.appendEvent(f.agent.id, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "execution" });
    f.append("I am browsing and running commands");
    const activity = () => f.receipt("original").liveProgress.activity;
    assert.equal(activity(), "working", "public prose does not establish activity");
    f.store.appendEvent(f.agent.id, { type: "command", command: "PRIVATE COMMAND", cwd: "/private", callId: "command" });
    assert.equal(activity(), "command", "uses the existing projector's Run association");
    f.store.appendEvent(f.agent.id, { type: "tool_result", id: "command", output: "PRIVATE OUTPUT" });
    assert.equal(activity(), "working");
    f.store.appendEvent(f.agent.id, { type: "tool_call", id: "tool", name: "unknown_tool", input: { text: "using the browser", private: "SECRET" } });
    assert.equal(activity(), "tool", "inputs and guessed names do not select browser activity");
    f.store.appendEvent(f.agent.id, { type: "tool_call", id: "browser", name: "ponderosa.ponderosa_browser_navigate", input: { url: "https://private.invalid" } });
    assert.equal(activity(), "browser");
    f.store.appendEvent(f.agent.id, { type: "tool_result", id: "browser", output: "SECRET PAGE" });
    assert.equal(activity(), "tool", "closing the newest call reveals the other still-open span");
    f.store.appendEvent(f.agent.id, { type: "tool_result", id: "tool", output: "done" });
    f.store.appendEvent(f.agent.id, { type: "command", command: "no matching ID", cwd: "/private" });
    assert.equal(activity(), "working", "missing evidence falls back safely");
    f.store.appendEvent(f.agent.id, { type: "tool_call", id: "foreign", name: "ponderosa_browser_act", input: {}, executionId: "foreign-run" });
    assert.equal(activity(), "working", "another Run cannot select the label");
    const progress = f.receipt("original").liveProgress;
    assert.equal(progress.text, "I am browsing and running commands");
    assert.doesNotMatch(JSON.stringify(progress), /SECRET|PRIVATE|private\.invalid|foreign/);
    assert.equal(f.store.getProjectedConversationMessages(f.chat.id, "main").length, 0);
    f.store.close();
    const reopened = new AgentStore(f.root);
    try {
      const receipt = new CoordinationV3Store(reopened.sqlite).deliveryReceiptsForCommunications(f.project.id, ["original"]).get("original")[0];
      assert.equal(receipt.liveProgress.activity, "working");
      assert.match(reopened.getRunOutputs(f.agent.id).map(item => item.text).join(""), /I am browsing/);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
