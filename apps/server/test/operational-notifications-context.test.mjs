import assert from "node:assert/strict";
import test from "node:test";
import { createOperationalNotifications } from "../dist/operational-notifications.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { registerNotificationListRoute, registerNotificationMutationRoutes } from "../dist/routes/notifications.js";

test("urgent message notices identify their Agent, Chat and exact source message without putting excerpts in push copy", () => {
  const created = [];
  const failures = ["message-one", "message-two"].map((communicationEventId, index) => ({
    id: `activation-${index}`, projectId: "project", agentId: "agent", kind: "human_message",
    scopeKey: "conversation:chat", communicationEventId, communicationIntent: "direct",
    state: "outcome_unknown", deliveryFailures: 1, supersededByRetry: false,
    updatedAt: "2026-10-01T12:00:00Z",
  }));
  const context = {
    store: {
      getAgent: () => ({ title: "Richmond" }),
      getConversation: () => ({ id: "chat", title: "Glance" }),
      getCommunicationEvent: (_projectId, id) => ({ text: `Please inspect ${id} before continuing.` }),
    },
    coordinationV3: { communicationAttentionActivations: () => failures },
    workspace: {
      cursor: () => 0,
      createNotification: (input, push) => { created.push({ ...input, push }); return input; },
      forEachOpenOperationalNotification: () => {},
    },
    publishWorkspaceSince: () => {},
  };
  createOperationalNotifications(context).reconcileCommunicationFailureNotifications();
  assert.equal(created.length, 2);
  assert.notEqual(created[0].dedupeKey, created[1].dedupeKey);
  for (const [index, notice] of created.entries()) {
    assert.match(notice.title, /Richmond/);
    assert.equal(notice.conversationId, "chat");
    assert.equal(notice.communicationEventId, failures[index].communicationEventId);
    assert.match(notice.contextPreview, new RegExp(failures[index].communicationEventId));
    assert.doesNotMatch(notice.body, /Please inspect/);
    assert.equal(notice.push, true);
    assert.equal(notice.workContext.recordId, failures[index].id);
    assert.equal(notice.workContext.occurredAt, failures[index].updatedAt);
  }
});

test("canonical uncertain assignments retain cause, exact identity and task without raw provider failure data", async () => {
  const root = mkdtempSync(join(tmpdir(), "attention-evidence-"));
  const store = new AgentStore(root), workspace = new WorkspaceStore(root);
  const coordinationV3 = new CoordinationV3Store(store.sqlite);
  const app = Fastify();
  try {
    const project = store.createProject({ label: "Glance", hostPath: root, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Watch support" });
    const requester = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: conversation.id });
    const recipient = store.createAgent(project.id, { title: "Richmond", engine: "codex", conversationId: conversation.id });
    coordinationV3.coordinate({ projectId: project.id, conversationId: conversation.id, requesterAgentId: requester.id,
      actorScope: "user:local-operator", idempotencyKey: "attention", requests: [{ requestId: "uncertain-request",
        recipientAgentId: recipient.id, lifetime: { kind: "indefinite" }, payload: { text: "Add a watch complication" } }] });
    coordinationV3.updateRequest({ requestId: "uncertain-request", updateId: "system:unknown:test", kind: "outcome_unknown",
      actor: { kind: "supervisor", id: "v3-runtime-supervisor" }, now: "2026-10-01T12:00:00Z",
      payload: { reason: "run_completed_without_request_update", runId: "run-123", privateError: "credential leak" } });
    const context = { store, workspace, coordinationV3, publishWorkspaceSince() {} };
    const operations = createOperationalNotifications(context);
    operations.reconcileCoordinationAttentionNotifications();
    operations.reconcileCoordinationAttentionNotifications();
    const notice = workspace.listNotificationPage({ limit: 100 }).items[0];
    assert.equal(workspace.listNotificationPage({ limit: 100 }).items.length, 1, "reconciliation does not duplicate notices");
    assert.equal(notice.workContext.recordId, "uncertain-request");
    assert.equal(notice.workContext.kind, "request");
    assert.equal(notice.workContext.occurredAt, "2026-10-01T12:00:00Z");
    assert.equal(notice.workContext.assignment, "Add a watch complication");
    assert.match(notice.body, /did not report whether this assignment was completed/);
    assert.doesNotMatch(JSON.stringify(notice), /credential leak/);
    registerNotificationListRoute(app, { workspace, store, publishWorkspaceSince() {} });
    registerNotificationMutationRoutes(app, { workspace, store, publishWorkspaceSince() {} });
    const listed = (await app.inject({ method: "GET", url: "/api/notifications" })).json().items[0];
    assert.equal(listed.projectLabel, "Glance");
    assert.equal(listed.conversationTitle, "Watch support");
    assert.equal(listed.agentTitle, "Richmond");
    assert.equal((await app.inject({ method: "POST", url: "/api/notifications/acknowledge-batch", payload: { notificationIds: [notice.id] } })).statusCode, 200);
    assert.equal(workspace.getNotification(notice.id).status, "open");
    assert.equal((await app.inject({ method: "POST", url: `/api/notifications/${notice.id}/status`, payload: { status: "dismissed" } })).statusCode, 200);
    assert.equal(coordinationV3.getRequest("uncertain-request").state, "outcome_unknown", "notification controls cannot settle work");
  } finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("notification names are projected once per distinct page scope and foreign Chat titles stay fenced", async () => {
  const app = Fastify();
  const base = { projectId: "project", conversationId: "chat", kind: "operational", category: "coordination",
    title: "A coordinated assignment needs a decision", body: "Historical issue", createdAt: "2026-10-01T12:00:00Z" };
  let projectReads = 0, chatReads = 0, title = "Marketing";
  registerNotificationListRoute(app, {
    workspace: { listNotificationPage: () => ({ items: Array.from({ length: 100 }, (_, i) => ({ ...base, id: String(i) })),
      openActionCount: 100, unacknowledgedActionCount: 100, unreadUpdateCount: 0 }) },
    store: { getAgentTitleProjection: () => new Map(), getProject: () => { projectReads++; return { label: "Project" }; },
      getConversation: () => { chatReads++; return { title, projectId: title === "foreign" ? "other-project" : "project" }; } },
    publishWorkspaceSince() {},
  });
  try {
    assert.equal((await app.inject("/api/notifications")).json().items[0].conversationTitle, "Marketing");
    assert.equal(projectReads, 1); assert.equal(chatReads, 1);
    title = "Renamed";
    assert.equal((await app.inject("/api/notifications")).json().items[0].conversationTitle, "Renamed");
    title = "foreign";
    assert.equal((await app.inject("/api/notifications")).json().items[0].conversationTitle, undefined);
  } finally { await app.close(); }
});

test("failed waits, Automations and missing recipients retain distinct canonical activity targets", () => {
  for (const [kind, state] of [["join", "impossible"], ["trigger", "dead_lettered"], ["request", "expired"]]) {
    const created = [];
    const item = { id: `${kind}:record-${kind}`, recordId: `record-${kind}`, referenceIds: [], kind, state,
      title: "Work", summary: "", agentIds: [kind === "request" ? "missing" : "manager"], relatedItemIds: [],
      ...(kind === "request" ? { requesterAgentId: "manager", recipientAgentId: "missing" } : {}),
      createdAt: "2026-10-01T11:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
    const agent = { id: "manager", title: "Manager", conversationId: "chat", archived: false };
    const context = {
      store: { listProjects: () => [{ id: "project" }], listAgents: () => [agent], agentCreationPending: () => false,
        getAgent: id => id === "manager" ? agent : undefined },
      coordinationV3: {
        coordinationAttentionCandidates: () => [{ kind, recordId: item.recordId, projectId: "project", agentId: "manager", updatedAt: item.updatedAt }],
        agentWorkItems: () => ({ items: [structuredClone(item)], truncated: false }),
        getRequest: () => kind === "request" ? { conversationId: "chat", requesterAgentId: "manager", payload: { text: "Review the release" } } : undefined,
        requestRetryStatus: () => ({}), requestLifecycleDetails: () => ({ updates: kind === "request"
          ? [{ resultingState: state, createdAt: item.updatedAt, text: "The required account connection was unavailable." }] : [] }),
        getTriggerOccurrence: () => ({ triggerSnapshot: { name: "Nightly audit", conversationId: "chat" } }),
      },
      workspace: { listDecisionPage: () => ({ decisions: [], hasMore: false }), getDecision: () => undefined,
        decisionsForRuns: () => [], cursor: () => 0, createNotification: input => { created.push(input); return input; },
        forEachOpenOperationalNotification() {} }, publishWorkspaceSince() {},
    };
    createOperationalNotifications(context).reconcileCoordinationAttentionNotifications();
    assert.equal(created.length, 1, `${kind}: notice retained`);
    assert.deepEqual(created[0].workContext, { kind, recordId: item.recordId, state, occurredAt: item.updatedAt,
      traceId: `trace:${item.id}`, ...(kind === "request" ? { assignment: "Review the release", detail: "The required account connection was unavailable." }
        : kind === "trigger" ? { assignment: "Automation: Nightly audit" } : {}) });
    assert.doesNotMatch(created[0].title, /A coordinated assignment/);
    if (kind === "request") {
      assert.equal(created[0].conversationId, "chat", "deleted recipient does not erase canonical Chat scope");
      assert.equal(created[0].resolution, undefined, "no invalid retry for a missing recipient");
      assert.doesNotMatch(created[0].body, /account connection/, "canonical detail stays out of push copy");
    }
  }
});
