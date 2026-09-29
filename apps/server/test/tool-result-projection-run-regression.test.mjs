import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { PONDEROSA_MESSAGE_TOOL } from "@ponderosa/core";
import { mapCodexAppServerNotification } from "@ponderosa/engines";
import Fastify from "fastify";
import { providerEventStream } from "../dist/provider-session-facade.js";
import { registerAgentCommunicationRoutes } from "../dist/routes/agent-communications.js";
import { createProviderDynamicToolHandler } from "../dist/routes/provider-dynamic-tool-handler.js";

function codexDynamicToolResult(id, result) {
  return mapCodexAppServerNotification({
    method: "item/completed",
    params: {
      item: {
        type: "dynamicToolCall",
        id,
        tool: PONDEROSA_MESSAGE_TOOL.name,
        success: result.success,
        contentItems: [{ type: "inputText", text: result.text }],
      },
    },
  }, "/tmp");
}

async function runReplyRecoveryScenario(t, intent) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-tool-result-run-"));
  const store = new AgentStore(dataDir);
  const project = store.createProject({
    label: "Tool failure recovery",
    hostPath: dataDir,
    defaultEngine: "codex",
  });
  const conversation = store.getConversation(project.lastConversationId);
  assert.ok(conversation);
  const agent = store.createAgent(project.id, {
    title: "Recovery Agent",
    engine: "codex",
    conversationId: conversation.id,
  });
  const coordinationV3 = new CoordinationV3Store(store.sqlite);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  const at = (offset) => new Date(startedAt + offset).toISOString();
  const workerId = `worker-${intent}`;
  const broadcastInput = {
    eventId: `broadcast-input-${intent}`,
    schemaVersion: 2,
    projectId: project.id,
    conversationId: conversation.id,
    sender: { kind: "user", userId: "local-operator" },
    intent: "broadcast",
    audience: { kind: "organization", organizationId: project.id },
    text: "Begin from this shared Broadcast.",
    createdAt: at(0),
  };
  coordinationV3.recordRuntimeCommunication({
    id: broadcastInput.eventId,
    projectId: project.id,
    sender: broadcastInput.sender,
    intent: broadcastInput.intent,
    audience: broadcastInput.audience,
    payload: {
      communication: broadcastInput,
      dispatch: {
        conversationId: conversation.id,
        text: broadcastInput.text,
        activeRunDelivery: "run",
        recipients: [{ agentId: agent.id, attachments: [] }],
      },
    },
    activation: {
      agentId: agent.id,
      kind: "human_message",
      priority: 100,
      dispatchPolicy: "next_run",
      promptClass: "human",
    },
    now: broadcastInput.createdAt,
  });
  const run = coordinationV3.leaseNextRun({ workerId, now: at(1) });
  assert.ok(run);
  assert.equal(run.agentId, agent.id);
  coordinationV3.markRunStarted(run.runId, run.fencingToken, at(2));
  coordinationV3.recordProviderInput({
    executionId: `execution-${intent}`,
    schedulerRunId: run.runId,
    fencingToken: run.fencingToken,
    agentId: agent.id,
    projectId: project.id,
    prompt: broadcastInput.text,
    sourceManifest: {
      schemaVersion: 1,
      historyMessageCount: 0,
      activationIds: run.activationIds,
      communicationEventIds: [broadcastInput.eventId],
      artifactIds: [],
      conversationId: conversation.id,
      providerSessionDisposition: "fresh_task",
      sources: [],
    },
    now: at(2),
  });
  coordinationV3.preparePromptInjection({
    injectionId: run.injectionId,
    runId: run.runId,
    fencingToken: run.fencingToken,
    prompt: broadcastInput.text,
    now: at(2),
  });
  coordinationV3.markPromptSubmitted({
    injectionId: run.injectionId,
    runId: run.runId,
    fencingToken: run.fencingToken,
    now: at(3),
  });
  coordinationV3.acknowledgePromptInjection({
    injectionId: run.injectionId,
    runId: run.runId,
    fencingToken: run.fencingToken,
    now: at(4),
  });

  const privateSteeringText = "PRIVATE STEERING: reply only to the operator";
  const directInput = {
    eventId: `direct-input-${intent}`,
    schemaVersion: 2,
    projectId: project.id,
    conversationId: conversation.id,
    sender: { kind: "user", userId: "local-operator" },
    intent: "user_dm",
    audience: {
      kind: "user_agent",
      userId: "local-operator",
      agentId: agent.id,
    },
    text: privateSteeringText,
    createdAt: at(5),
  };
  const directIntake = coordinationV3.recordRuntimeCommunication({
    id: directInput.eventId,
    projectId: project.id,
    sender: directInput.sender,
    intent: directInput.intent,
    audience: directInput.audience,
    payload: {
      communication: directInput,
      dispatch: {
        conversationId: conversation.id,
        text: directInput.text,
        activeRunDelivery: "steer",
        recipients: [{ agentId: agent.id, attachments: [] }],
      },
    },
    activation: {
      agentId: agent.id,
      kind: "human_message",
      priority: 100,
      dispatchPolicy: "steer_or_run",
      promptClass: "human",
    },
    now: directInput.createdAt,
  });
  const steering = coordinationV3.leaseNextSteering({ workerId, now: at(6) });
  assert.ok(steering);
  assert.equal(steering.runId, run.runId);
  coordinationV3.preparePromptInjection({
    injectionId: steering.injectionId,
    runId: steering.runId,
    fencingToken: steering.fencingToken,
    prompt: directInput.text,
    now: at(6),
  });
  coordinationV3.markPromptSubmitted({
    injectionId: steering.injectionId,
    runId: steering.runId,
    fencingToken: steering.fencingToken,
    now: at(7),
  });
  coordinationV3.acknowledgePromptInjection({
    injectionId: steering.injectionId,
    runId: steering.runId,
    fencingToken: steering.fencingToken,
    now: at(8),
  });
  assert.deepEqual(
    coordinationV3.requiredReplyAuthoritiesForRun(run.runId),
    [{ intent: "broadcast" }],
  );
  assert.equal(
    coordinationV3.deliveryReceiptsForCommunication(project.id, directInput.eventId)[0]?.state,
    "delivered",
  );

  const runId = run.runId;
  const steeringInjectionId = steering.injectionId;
  const messageCapability = `capability-${intent}`;
  const capability = {
    agentId: agent.id,
    conversationId: conversation.id,
    runId,
    v3SchedulerRunId: runId,
    v3FencingToken: run.fencingToken,
    mentionDepth: 0,
    mentionTrail: [],
    reachableArtifactIds: [],
    availableToolNames: [PONDEROSA_MESSAGE_TOOL.name],
    historyRetrievalExcludedCommunicationEventIds: [],
  };
  registerAgentCommunicationRoutes(app, {
    store,
    coordinationV3,
    workspace: {},
    agentMessageCapabilities: new Map([[messageCapability, capability]]),
    activeRuns: new Map([[agent.id, { messageCapability }]]),
    projectDeletionInProgress: () => false,
    conversationDeletionInProgress: () => false,
    agentDeletionInProgress: () => false,
    conversationDeliveryLeases: new Map(),
    agentDeliveryLeases: new Map(),
    capabilityOwnsAuthoritativeRun: () => true,
    runAuthorization: () => ({
      runId,
      agentId: agent.id,
      fencingToken: run.fencingToken,
    }),
    recordCommunication: (communication) => communication,
    projectBroadcastToAgentAudits: () => {},
    projectCommunicationToAgentAudit: () => {},
    resolveExplicitCollaborationIntents: () => ({ text: "", intents: [], blocked: [] }),
    appendBlockedMentionWarnings: () => {},
    communicationArtifactAccess: () => ({}),
    projectCommunicationArtifact: () => {},
    runtimeArtifactMetadata: (artifact) => artifact,
    stageCommunicationArtifact: async () => {
      throw new Error("small replies must not stage an artifact");
    },
    removeRuntimeArtifactReservation: () => {},
    publishCoordinationV3Changed: () => {},
    publishWorkspaceSince: () => {},
    resolveOperationalNotification: () => {},
    notifyScheduler: () => {},
    reconcileRuntimeCommunicationProjections: async () => 0,
    publish: () => {},
  });

  const dynamicToolHandler = createProviderDynamicToolHandler(
    app,
    [PONDEROSA_MESSAGE_TOOL],
    messageCapability,
  );
  const agentCommunications = () => coordinationV3.runtimeCommunications(project.id)
    .map((communication) => communication.payload?.communication)
    .filter((communication) => communication?.sender?.kind === "agent");
  const projected = [];
  const correctedText = intent === "direct_to_user"
    ? "Private answer after correcting the route."
    : "Shared answer after correcting the route.";

  async function* providerTurn() {
    const ambiguous = await dynamicToolHandler({
      id: "ambiguous-message",
      name: PONDEROSA_MESSAGE_TOOL.name,
      arguments: {
        text: privateSteeringText,
        steeringInjectionId,
      },
    });
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.text, /no unambiguous reply route/u);
    assert.equal(agentCommunications().length, 0);
    yield* codexDynamicToolResult("ambiguous-message", ambiguous);

    const corrected = await dynamicToolHandler({
      id: "corrected-message",
      name: PONDEROSA_MESSAGE_TOOL.name,
      arguments: {
        intent,
        text: correctedText,
        steeringInjectionId,
      },
    });
    assert.equal(corrected.success, true, corrected.text);
    yield* codexDynamicToolResult("corrected-message", corrected);
    yield* mapCodexAppServerNotification({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    }, "/tmp");
  }

  for await (const event of providerEventStream(providerTurn())) {
    projected.push(event);
    store.appendEvent(agent.id, event);
  }
  coordinationV3.completeRun(run.runId, run.fencingToken, at(10));

  const failedToolResult = projected.find((event) =>
    event.type === "tool_result" && event.id === "ambiguous-message");
  assert.ok(failedToolResult);
  assert.equal(failedToolResult.isError, true);
  assert.equal(failedToolResult.failureCategory, "invalid_input");
  assert.equal(failedToolResult.retryable, false);
  assert.match(failedToolResult.output, /no unambiguous reply route/u);
  assert.equal(projected.some((event) => event.type === "error"), false);
  assert.equal(projected.at(-1)?.type, "turn_done");

  const activityFailure = store.getActivity(agent.id).find((activity) =>
    activity.event.type === "tool_result" && activity.event.id === "ambiguous-message");
  assert.deepEqual(activityFailure?.event, failedToolResult);
  const communications = agentCommunications();
  assert.equal(communications.length, 1);
  assert.equal(communications[0].intent, intent === "direct_to_user" ? "user_dm" : "broadcast");
  assert.equal(communications[0].text, correctedText);
  assert.equal(communications[0].text.includes(privateSteeringText), false);
  assert.equal(
    capability.inferredReplyCommunicationEventId,
    intent === "broadcast" ? communications[0].eventId : undefined,
  );
  assert.equal(coordinationV3.activeAgentRun(agent.id), undefined);
  assert.deepEqual(
    store.sqlite.prepare(`
      SELECT status, provider_failure_json providerFailure
      FROM scheduler_runs WHERE id = ?
    `).get(run.runId),
    { status: "completed", providerFailure: null },
  );
  assert.equal(
    store.sqlite.prepare("SELECT state FROM agent_activations WHERE id = ?")
      .get(directIntake.activationId).state,
    "consumed",
  );
  assert.equal(
    coordinationV3.deliveryReceiptsForCommunication(project.id, directInput.eventId)[0]?.state,
    "processed",
  );
  const broadcastObligation = coordinationV3.requiredReplyObligationsForRun(run.runId)
    .find((obligation) => obligation.replyAuthority.intent === "broadcast");
  assert.equal(
    broadcastObligation?.state,
    intent === "broadcast" ? "satisfied" : "recovery_pending",
  );
  assert.equal(
    coordinationV3.terminalActivations(project.id)
      .some((activation) => activation.state === "outcome_unknown"),
    false,
  );

  return communications;
}

test("a failed ambiguous tool result remains activity and the same Run can satisfy a private Direct steer", async (t) => {
  const communications = await runReplyRecoveryScenario(t, "direct_to_user");
  assert.equal(communications.filter((event) => event.intent === "user_dm").length, 1);
  assert.equal(communications.filter((event) => event.intent === "broadcast").length, 0);
});

test("the same failed-tool recovery can explicitly Broadcast without leaking private steering", async (t) => {
  const communications = await runReplyRecoveryScenario(t, "broadcast");
  assert.equal(communications.filter((event) => event.intent === "broadcast").length, 1);
  assert.equal(communications.filter((event) => event.intent === "user_dm").length, 0);
});

test("a first Run has an unambiguous bare reply route for either user communication scope", async () => {
  for (const intent of ["broadcast", "user_dm"]) {
    const dataDir = await mkdtemp(path.join(tmpdir(), `ponderosa-first-reply-${intent}-`));
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: "First reply route", hostPath: dataDir, defaultEngine: "codex" });
    const conversation = store.getConversation(project.lastConversationId);
    assert.ok(conversation);
    const agent = store.createAgent(project.id, { title: "First Run Agent", engine: "codex", conversationId: conversation.id });
    const coordinationV3 = new CoordinationV3Store(store.sqlite);
    const app = Fastify();
    try {
      const input = {
        eventId: `first-input-${intent}`,
        schemaVersion: 2,
        projectId: project.id,
        conversationId: conversation.id,
        sender: { kind: "user", userId: "local-operator" },
        intent,
        audience: intent === "broadcast"
          ? { kind: "organization", organizationId: project.id }
          : { kind: "user_agent", userId: "local-operator", agentId: agent.id },
        text: "Please reply to this first message.",
        createdAt: new Date().toISOString(),
      };
      coordinationV3.recordRuntimeCommunication({
        id: input.eventId,
        projectId: project.id,
        sender: input.sender,
        intent: input.intent,
        audience: input.audience,
        payload: {
          communication: input,
          dispatch: {
            conversationId: conversation.id,
            text: input.text,
            activeRunDelivery: "run",
            recipients: [{ agentId: agent.id, attachments: [] }],
          },
        },
        activation: {
          agentId: agent.id,
          kind: "human_message",
          priority: 100,
          dispatchPolicy: "next_run",
          promptClass: "human",
        },
        now: input.createdAt,
      });
      const run = coordinationV3.leaseNextRun({ workerId: `worker-${intent}` });
      assert.ok(run);
      coordinationV3.markRunStarted(run.runId, run.fencingToken);
      const replyAuthority = coordinationV3.requiredReplyObligationForRun(run.runId)?.replyAuthority;
      assert.deepEqual(replyAuthority, { intent: intent === "broadcast" ? "broadcast" : "direct_to_user" });
      const token = `first-capability-${intent}`;
      const capability = {
        agentId: agent.id,
        conversationId: conversation.id,
        runId: run.runId,
        v3SchedulerRunId: run.runId,
        v3FencingToken: run.fencingToken,
        defaultReply: replyAuthority,
        mentionDepth: 0,
        mentionTrail: [],
        reachableArtifactIds: [],
        availableToolNames: [PONDEROSA_MESSAGE_TOOL.name],
        historyRetrievalExcludedCommunicationEventIds: [],
      };
      registerAgentCommunicationRoutes(app, {
        store,
        coordinationV3,
        workspace: {},
        agentMessageCapabilities: new Map([[token, capability]]),
        activeRuns: new Map([[agent.id, { messageCapability: token }]]),
        projectDeletionInProgress: () => false,
        conversationDeletionInProgress: () => false,
        agentDeletionInProgress: () => false,
        conversationDeliveryLeases: new Map(),
        agentDeliveryLeases: new Map(),
        capabilityOwnsAuthoritativeRun: () => true,
        runAuthorization: () => ({ runId: run.runId, agentId: agent.id, fencingToken: run.fencingToken }),
        recordCommunication: (communication) => communication,
        projectBroadcastToAgentAudits: () => {},
        projectCommunicationToAgentAudit: () => {},
        resolveExplicitCollaborationIntents: () => ({ text: "", intents: [], blocked: [] }),
        appendBlockedMentionWarnings: () => {},
        communicationArtifactAccess: () => ({}),
        projectCommunicationArtifact: () => {},
        runtimeArtifactMetadata: (artifact) => artifact,
        stageCommunicationArtifact: async () => { throw new Error("small replies must not stage an artifact"); },
        removeRuntimeArtifactReservation: () => {},
        publishCoordinationV3Changed: () => {},
        publishWorkspaceSince: () => {},
        publish: () => {},
        resolveOperationalNotification: () => {},
        notifyScheduler: () => {},
        reconcileRuntimeCommunicationProjections: async () => 0,
      });
      const dynamicToolHandler = createProviderDynamicToolHandler(app, [PONDEROSA_MESSAGE_TOOL], token);
      const result = await dynamicToolHandler({
        id: `first-reply-${intent}`,
        name: PONDEROSA_MESSAGE_TOOL.name,
        arguments: { text: "First Run reply without an explicit intent." },
      });
      assert.equal(result.success, true, result.text);
      const communications = coordinationV3.runtimeCommunications(project.id)
        .map((communication) => communication.payload?.communication)
        .filter((communication) => communication?.sender?.kind === "agent");
      assert.equal(communications.length, 1);
      assert.equal(communications[0].intent, intent);
    } finally {
      await app.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
