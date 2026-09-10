import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  AgentStore,
  CoordinationIdempotencyConflictError,
  CoordinationV3Store,
} from "../dist/index.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-v3-edit-stop-"));
  const store = new AgentStore(directory);
  const coordination = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({
    label: "Project",
    hostPath: "/tmp/project",
    defaultEngine: "codex",
  });
  const conversation = store.createConversation(project.id, { title: "Chat" });
  const recipients = ["Recipient A", "Recipient B"].map((title) =>
    store.createAgent(project.id, {
      title,
      engine: "codex",
      conversationId: conversation.id,
    }));
  return {
    directory,
    store,
    coordination,
    project,
    conversation,
    recipients,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function editWorker(workerData) {
  const worker = new Worker(
    new URL("./coordination-v3-queued-edit-worker.mjs", import.meta.url),
    { workerData },
  );
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.ready) readyResolve();
      else if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.once("error", (error) => {
      readyReject(error);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`queued-edit worker exited ${code}`);
        readyReject(error);
        reject(error);
      }
    });
  });
  return { worker, ready, result };
}

function enqueue(context, eventId, text, recipients = context.recipients) {
  const now = "2026-09-10T12:00:00.000Z";
  const agentIds = recipients.map((recipient) => recipient.id);
  const communication = {
    eventId,
    schemaVersion: 2,
    projectId: context.project.id,
    conversationId: context.conversation.id,
    sender: { kind: "user", userId: "local-operator" },
    intent: "user_dm",
    audience: {
      kind: "user_agents",
      userId: "local-operator",
      agentIds,
    },
    text,
    createdAt: now,
  };
  return context.coordination.recordRuntimeCommunication({
    id: eventId,
    projectId: context.project.id,
    sender: communication.sender,
    intent: communication.intent,
    audience: communication.audience,
    payload: {
      communication,
      dispatch: {
        conversationId: context.conversation.id,
        text,
        activeRunDelivery: "queue",
        recipients: recipients.map((recipient) => ({
          agentId: recipient.id,
          attachments: [],
        })),
      },
    },
    activations: recipients.map((recipient, index) => ({
      agentId: recipient.id,
      kind: "human_message",
      priority: 100,
      dispatchPolicy: "next_run",
      promptClass: "human",
      dedupeKey: `communication:${eventId}:${recipient.id}:${index}`,
    })),
    now,
  });
}

function editInput(context, activationId, eventId, text, idempotencyKey) {
  const revisionId = `revision-${idempotencyKey}`;
  return {
    activationId,
    projectId: context.project.id,
    requestText: text,
    text,
    revisionOwnerId: revisionId,
    revisionOutboxPayload: {
      activationId,
      agentId: context.coordination.activation(activationId, context.project.id).agentId,
      conversationId: context.conversation.id,
      revision: {
        eventId: revisionId,
        schemaVersion: 1,
        projectId: context.project.id,
        conversationId: context.conversation.id,
        targetEventId: eventId,
        kind: "edit",
        sender: { kind: "user", userId: "local-operator" },
        text,
        createdAt: "2026-09-10T12:00:01.000Z",
        idempotencyKey,
      },
    },
    idempotencyKey,
    now: "2026-09-10T12:00:01.000Z",
  };
}

function activationText(context, activationId) {
  const payload = context.coordination.activation(activationId, context.project.id).payload;
  return {
    communication: payload.communication.text,
    dispatch: payload.dispatch.text,
  };
}

test("queued edits update every pending recipient and duplicate submissions replay once", () => {
  const context = fixture();
  try {
    const intake = enqueue(context, "shared-message", "original");
    const firstInput = editInput(
      context,
      intake.activationIds[0],
      "shared-message",
      "edited for everyone",
      "edit-once",
    );
    assert.deepEqual(context.coordination.editPendingActivationText(firstInput), {
      edited: true,
      replayed: false,
      status: "edited",
    });
    for (const activationId of intake.activationIds) {
      assert.deepEqual(activationText(context, activationId), {
        communication: "edited for everyone",
        dispatch: "edited for everyone",
      });
    }
    assert.deepEqual(context.coordination.editPendingActivationText(firstInput), {
      edited: true,
      replayed: true,
      status: "edited",
    });
    assert.equal(context.store.sqlite.prepare(`
      SELECT COUNT(*) count FROM activation_outbox
      WHERE event_kind = 'communication_revision'
    `).get().count, 1);

    const secondInput = editInput(
      context,
      intake.activationIds[1],
      "shared-message",
      "latest edit",
      "edit-twice",
    );
    assert.equal(context.coordination.editPendingActivationText(secondInput).edited, true);
    for (const activationId of intake.activationIds) {
      assert.deepEqual(activationText(context, activationId), {
        communication: "latest edit",
        dispatch: "latest edit",
      });
    }
  } finally {
    context.close();
  }
});

test("concurrent queued edits serialize every sibling to the last durable revision", async () => {
  const context = fixture();
  try {
    const intake = enqueue(context, "concurrent-message", "original");
    const workers = intake.activationIds.map((activationId, index) => editWorker({
      directory: context.directory,
      projectId: context.project.id,
      conversationId: context.conversation.id,
      activationId,
      agentId: context.recipients[index].id,
      eventId: "concurrent-message",
      text: `concurrent edit ${index}`,
      idempotencyKey: `concurrent-edit-${index}`,
    }));
    await Promise.all(workers.map(({ ready }) => ready));
    for (const { worker } of workers) worker.postMessage("start");
    assert.deepEqual(await Promise.all(workers.map(({ result }) => result)), [
      { edited: true, replayed: false, status: "edited" },
      { edited: true, replayed: false, status: "edited" },
    ]);
    const revisions = context.store.sqlite.prepare(`
      SELECT payload_json FROM activation_outbox
      WHERE event_kind = 'communication_revision'
      ORDER BY id
    `).all();
    assert.equal(revisions.length, 2);
    const latestText = JSON.parse(revisions.at(-1).payload_json).revision.text;
    for (const activationId of intake.activationIds) {
      assert.deepEqual(activationText(context, activationId), {
        communication: latestText,
        dispatch: latestText,
      });
    }
  } finally {
    context.close();
  }
});

test("queued edit rejects atomically after any shared recipient delivery starts", () => {
  const context = fixture();
  try {
    const intake = enqueue(context, "partly-started-message", "original");
    const lease = context.coordination.leaseNextRun({
      workerId: "worker-a",
      now: "2026-09-10T12:00:01.000Z",
    });
    assert.ok(lease);
    const pendingActivationId = intake.activationIds.find((id) => id !== lease.activationIds[0]);
    assert.ok(pendingActivationId);
    assert.deepEqual(context.coordination.editPendingActivationText(editInput(
      context,
      pendingActivationId,
      "partly-started-message",
      "must not publish",
      "edit-after-start",
    )), {
      edited: false,
      replayed: false,
      status: "delivery_started",
    });
    for (const activationId of intake.activationIds) {
      assert.deepEqual(activationText(context, activationId), {
        communication: "original",
        dispatch: "original",
      });
    }
    assert.equal(context.store.sqlite.prepare(`
      SELECT COUNT(*) count FROM activation_outbox
      WHERE event_kind = 'communication_revision'
    `).get().count, 0);
  } finally {
    context.close();
  }
});

test("Stop replay is bound to its successful target Run", () => {
  const context = fixture();
  try {
    const first = enqueue(context, "run-one-message", "run one", [context.recipients[0]]);
    const runOne = context.coordination.leaseNextRun({ workerId: "worker-a" });
    assert.ok(runOne);
    const request = {
      agentId: context.recipients[0].id,
      idempotencyKey: "stop-once",
      expectedRunId: runOne.runId,
    };
    const cancelled = context.coordination.cancelAgentRun(request);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.runId, runOne.runId);
    assert.deepEqual(context.coordination.cancelAgentRun(request), {
      cancelled: true,
      runId: cancelled.runId,
      fencingToken: cancelled.fencingToken,
      replayed: true,
    });
    assert.ok(first.activationIds.includes(runOne.activationIds[0]));

    enqueue(context, "run-two-message", "run two", [context.recipients[0]]);
    const runTwo = context.coordination.leaseNextRun({ workerId: "worker-b" });
    assert.ok(runTwo);
    assert.throws(() => context.coordination.cancelAgentRun({
      ...request,
      expectedRunId: runTwo.runId,
    }), CoordinationIdempotencyConflictError);
    assert.equal(
      context.coordination.agentSnapshot(context.recipients[0].id).activeRun?.id,
      runTwo.runId,
    );
  } finally {
    context.close();
  }
});

test("Stop replay is bound to its inactive target Run", () => {
  const context = fixture();
  try {
    const request = {
      agentId: context.recipients[0].id,
      idempotencyKey: "inactive-stop-once",
      expectedRunId: "inactive-run",
    };
    assert.deepEqual(context.coordination.cancelAgentRun(request), {
      cancelled: false,
      replayed: false,
      runId: "inactive-run",
    });
    assert.deepEqual(context.coordination.cancelAgentRun(request), {
      cancelled: false,
      replayed: true,
      runId: "inactive-run",
    });

    enqueue(context, "active-after-inactive-stop", "active", [context.recipients[0]]);
    const active = context.coordination.leaseNextRun({ workerId: "worker-a" });
    assert.ok(active);
    assert.throws(() => context.coordination.cancelAgentRun({
      ...request,
      expectedRunId: active.runId,
    }), CoordinationIdempotencyConflictError);
    assert.equal(
      context.coordination.agentSnapshot(context.recipients[0].id).activeRun?.id,
      active.runId,
    );
  } finally {
    context.close();
  }
});
