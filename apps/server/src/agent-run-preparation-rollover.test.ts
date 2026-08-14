import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, ArtifactDto } from "@ponderosa/core";
import {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
  publishManagedArtifactContent,
} from "@ponderosa/agents";
import { afterEach, describe, expect, test } from "vitest";
import { AssetStore } from "./assets.js";
import type { EngineRegistration } from "./app-contracts.js";
import { ContextCursorStore } from "./context-cursors.js";
import type { AgentMessageRunContext } from "./routes/agent-message-run.js";
import { prepareAgentRun } from "./routes/agent-run-preparation.js";

const NOW = "2026-08-14T00:00:00.000Z";
const roots: string[] = [];
const stores: AgentStore[] = [];
const assetStores: AssetStore[] = [];

afterEach(() => {
  while (assetStores.length) assetStores.pop()!.close();
  while (stores.length) stores.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const hashFor = (value: string): string => createHash("sha256").update(value).digest("hex");

const adapter: Adapter = {
  id: "codex",
  displayName: "Codex test adapter",
  trustedSystemPromptChannel: "developer",
  listModels: () => [],
  listEfforts: () => [],
  async *continue() {},
  async *seed() {},
};

describe("context rollover provider-input preparation", () => {
  test("keeps referenced published and pinned artifacts out of replacement, then delivers them once after acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-rollover-preparation-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const hostPath = join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    stores.push(store);
    const assets = new AssetStore(dataDir);
    assetStores.push(assets);
    const workspace = new WorkspaceStore(dataDir);
    const coordinationV3 = new CoordinationV3Store(store.sqlite);
    const contextCursors = new ContextCursorStore(dataDir);
    const project = store.createProject({
      label: "Rollover artifact fixture",
      hostPath,
      defaultEngine: "codex",
    });
    const conversationId = project.lastConversationId!;
    const requester = store.createAgent(project.id, {
      title: "Requester",
      engine: "codex",
      conversationId,
    });
    const agent = store.createAgent(project.id, {
      title: "Recipient",
      engine: "codex",
      conversationId,
    });
    const publishedArtifactId = randomUUID();
    const pinnedArtifactId = randomUUID();
    const tailEventId = "submitted-tail";
    store.appendCommunicationEvent({
      schemaVersion: 2,
      eventId: tailEventId,
      projectId: project.id,
      conversationId,
      sender: { kind: "user", userId: "local-user" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-user", agentId: agent.id },
      text: `Keep the frozen text references ponderosa://artifact/${publishedArtifactId} and ponderosa://artifact/${pinnedArtifactId}.`,
      createdAt: NOW,
    });
    const boundary = store.bindContextRolloverBoundary({
      agentId: agent.id,
      currentConversationId: conversationId,
      submittedCommunicationEventIds: [tailEventId],
    });

    const requestId = coordinationV3.coordinate({
      projectId: project.id,
      conversationId,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "rollover-artifact-source",
      requests: [{
        recipientAgentId: agent.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "Continue the accepted work after rollover." },
      }],
    }, NOW).requestIds[0]!;
    expect(requestId).toBeTruthy();
    const sourceRun = coordinationV3.leaseNextRun({ workerId: "source", now: NOW });
    if (!sourceRun) throw new Error("source Run was not leased");
    coordinationV3.markRunStarted(sourceRun.runId, sourceRun.fencingToken, NOW);
    coordinationV3.preparePromptInjection({
      injectionId: sourceRun.injectionId,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      prompt: "accepted source prompt",
      now: NOW,
    });
    coordinationV3.markPromptSubmitted({
      injectionId: sourceRun.injectionId,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    coordinationV3.acknowledgePromptInjection({
      injectionId: sourceRun.injectionId,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    const requested = coordinationV3.requestContextRollover({
      projectId: project.id,
      agentId: agent.id,
      oldProviderSessionId: "provider-old",
      providerSessionGeneration: "generation-artifact",
      detectedOccupancy: 80_000,
      threshold: 75_000,
      lowWaterMark: 25_000,
      compactionCutoffOrdinal: boundary.canonicalOrdinal,
      compactionCutoffEventId: boundary.communicationEventId,
      recentTail: boundary.recentTail,
      sourceRunId: sourceRun.runId,
      sourceActivationIds: sourceRun.activationIds,
      scopeKey: sourceRun.scopeKey,
      conversationId,
      replyAuthority: { intent: "direct_to_user" },
      now: NOW,
    });
    coordinationV3.completeRun(sourceRun.runId, sourceRun.fencingToken, NOW);

    const handoffRun = coordinationV3.leaseNextRun({ workerId: "handoff", now: NOW });
    if (!handoffRun) throw new Error("handoff Run was not leased");
    coordinationV3.markRunStarted(handoffRun.runId, handoffRun.fencingToken, NOW);
    coordinationV3.preparePromptInjection({
      injectionId: handoffRun.injectionId,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      prompt: "bounded handoff prompt",
      now: NOW,
    });
    coordinationV3.markPromptSubmitted({
      injectionId: handoffRun.injectionId,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    coordinationV3.acknowledgePromptInjection({
      injectionId: handoffRun.injectionId,
      runId: handoffRun.runId,
      fencingToken: handoffRun.fencingToken,
      providerSessionId: "provider-old",
      now: NOW,
    });
    const handoffId = `handoff:${requested.rollover.id}`;
    const handoffText = "Bounded continuation state for the artifact rollover fixture.";
    store.sqlite.prepare(`
      INSERT INTO continuation_handoffs (
        id, agent_id, source_execution_id, text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(handoffId, agent.id, handoffRun.runId, handoffText, NOW);
    coordinationV3.commitContextRolloverHandoff(requested.rollover.id, handoffId, NOW);
    coordinationV3.completeRun(handoffRun.runId, handoffRun.fencingToken, NOW);
    coordinationV3.beginContextRolloverRetirement(requested.rollover.id, NOW);
    coordinationV3.prepareContextRolloverContinuation({ id: requested.rollover.id, now: NOW });
    const candidateRun = coordinationV3.leaseNextRun({ workerId: "candidate", now: NOW });
    if (!candidateRun) throw new Error("replacement Run was not leased");
    coordinationV3.markRunStarted(candidateRun.runId, candidateRun.fencingToken, NOW);

    const registerContextArtifact = (
      artifactId: string,
      visibility: "project" | "published",
      pinned: boolean,
    ): void => {
      const artifactBody = Buffer.from(`${visibility} context artifact`, "utf8");
      const publication = publishManagedArtifactContent(dataDir, project.id, artifactId, artifactBody);
      const artifact = {
        id: artifactId,
        projectId: project.id,
        agentId: agent.id,
        originAgentId: agent.id,
        executionId: sourceRun.runId,
        kind: "generated_file",
        path: `artifacts/${artifactId}.txt`,
        sourcePath: `reports/${artifactId}.txt`,
        summary: `${artifactId}.txt`,
        createdAt: NOW,
        mediaType: "text/plain",
        visibility,
        pinned,
        size: artifactBody.length,
        sha256: publication.sha256,
      } satisfies ArtifactDto & {
        projectId: string;
        originAgentId: string;
        kind: "generated_file";
        summary: string;
        mediaType: string;
        size: number;
        sha256: string;
      };
      assets.registerPublishedGeneratedArtifact(artifact, publication);
      store.recordProjectArtifact(artifact);
    };
    registerContextArtifact(publishedArtifactId, "published", false);
    registerContextArtifact(pinnedArtifactId, "project", true);
    expect(store.getProjectContextArtifacts(project.id).map((item) => item.id).sort())
      .toEqual([pinnedArtifactId, publishedArtifactId].sort());

    const engine: EngineRegistration = { adapter };
    const runContext = {
      opts: { dataDir, engines: [engine] },
      store,
      workspace,
      coordinationV3,
      assets,
      contextCursors,
      organizationEnvelopeStates: new Map(),
      scheduledSessionRollovers: new Map(),
      reusableRuntime: () => undefined,
      clearAgentResumeSession: () => undefined,
      cancelRuntimeIdleClose: () => undefined,
      reconcileAgentRuntimeAuthority: async () => undefined,
      teardownPersistentRuntime: async () => undefined,
      teamDirectory: () => ({
        projectId: project.id,
        generatedAt: NOW,
        agents: [{
          agentId: agent.id,
          displayName: agent.title,
          role: "Generalist",
          description: "Rollover test recipient",
          status: "running" as const,
          childAgentIds: [],
          engine: "codex" as const,
        }],
      }),
      canonicalConversationContext: () => undefined,
      agentCanReadRuntimeArtifact: () => false,
    } as unknown as AgentMessageRunContext;
    const prepareRun = (run: {
      runId: string;
      injectionId: string;
    }, text: string) => prepareAgentRun(runContext, {
      agent,
      project,
      runtimeEngineId: "codex",
      engine,
      text,
      internalV3Dispatch: true,
      v3SchedulerRunId: run.runId,
      v3InjectionId: run.injectionId,
      v3FreshProviderSession: false,
      v3ActivationPrompt: text,
      effectiveModel: undefined,
      effectiveEffort: undefined,
      messageAttachments: [],
      sourceConversationId: conversationId,
      communicationEventId: undefined,
      communication: undefined,
      sharedCommunication: undefined,
      sharedTaskTurn: false,
      directUserTaskTurn: false,
      sourceMasterMessage: undefined,
      pendingTurn: {
        text,
        agentMentionDepth: 0,
        agentMentionTrail: [],
        sourceConversationId: conversationId,
      },
      requestedSourceChannel: undefined,
    });
    const prepared = await prepareRun(candidateRun, "Continue after rollover.");

    expect(prepared.seedHistory).toHaveLength(1);
    expect(prepared.seedHistory[0]).toMatchObject({
      text: `Keep the frozen text references ponderosa://artifact/${publishedArtifactId} and ponderosa://artifact/${pinnedArtifactId}.`,
    });
    expect(prepared.seedHistory[0]?.attachments).toEqual([]);
    expect(prepared.providerInputManifest.artifactIds).toEqual([]);
    expect(prepared.providerInputManifest.sources.some((source) =>
      source.kind === "artifact" || source.kind === "history_message"
    )).toBe(false);
    expect(prepared.exactProviderInput).toContain(`ponderosa://artifact/${publishedArtifactId}`);
    expect(prepared.exactProviderInput).toContain(`ponderosa://artifact/${pinnedArtifactId}`);
    expect(prepared.exactProviderInput).not.toContain("[artifact:");
    expect(prepared.exactProviderInput).not.toContain("Pinned or published project artifacts");

    expect(coordinationV3.recordProviderInputAndCommitContextRolloverReplacement({
      executionId: candidateRun.runId,
      schedulerRunId: candidateRun.runId,
      fencingToken: candidateRun.fencingToken,
      agentId: agent.id,
      projectId: project.id,
      prompt: prepared.exactProviderInput,
      systemPrompt: prepared.systemPrompt,
      sourceManifest: prepared.providerInputManifest,
      now: NOW,
    })).toMatchObject({
      id: requested.rollover.id,
      replacementRunId: candidateRun.runId,
      state: "continuation_ready",
    });
    expect(hashFor(handoffText)).toBe(
      prepared.providerInputManifest.sources.find((source) =>
        source.kind === "continuation_handoff"
      )?.hash,
    );

    coordinationV3.preparePromptInjection({
      injectionId: candidateRun.injectionId,
      runId: candidateRun.runId,
      fencingToken: candidateRun.fencingToken,
      prompt: prepared.exactProviderInput,
      now: NOW,
    });
    coordinationV3.markPromptSubmitted({
      injectionId: candidateRun.injectionId,
      runId: candidateRun.runId,
      fencingToken: candidateRun.fencingToken,
      providerSessionId: "provider-new",
      now: NOW,
    });
    coordinationV3.acknowledgePromptInjection({
      injectionId: candidateRun.injectionId,
      runId: candidateRun.runId,
      fencingToken: candidateRun.fencingToken,
      providerSessionId: "provider-new",
      now: NOW,
    });
    coordinationV3.recordContextRolloverReplacementSessionForRun(
      candidateRun.runId,
      agent.id,
      "provider-new",
      NOW,
    );
    expect(coordinationV3.observeContextRolloverReplacementOccupancy(
      requested.rollover.id,
      "provider-new",
      10_000,
      NOW,
    ).replacementVerifiedAt).toBe(NOW);
    store.appendEvent(agent.id, {
      type: "context_rollover_session_accepted",
      rolloverId: requested.rollover.id,
      sessionId: "provider-new",
      toolContractHash: prepared.runtimeSessionContractHash,
      artifactIds: [],
      handoffId,
      executionId: candidateRun.runId,
    });
    coordinationV3.completeVerifiedContextRolloverReplacement(
      requested.rollover.id,
      "provider-new",
      NOW,
    );
    coordinationV3.completeRun(candidateRun.runId, candidateRun.fencingToken, NOW);
    expect(store.resumeSessionState(agent.id)).toEqual({
      sessionId: "provider-new",
      toolContractHash: prepared.runtimeSessionContractHash,
      artifactIds: [],
    });

    coordinationV3.coordinate({
      projectId: project.id,
      conversationId,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "post-acceptance-artifact-delivery",
      requests: [{
        recipientAgentId: agent.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "Use the accepted replacement session." },
      }],
    }, NOW);
    let nextRun = coordinationV3.leaseNextRun({ workerId: "next", now: NOW });
    while (nextRun && nextRun.agentId !== agent.id) {
      coordinationV3.markRunStarted(nextRun.runId, nextRun.fencingToken, NOW);
      coordinationV3.preparePromptInjection({
        injectionId: nextRun.injectionId,
        runId: nextRun.runId,
        fencingToken: nextRun.fencingToken,
        prompt: "settle unrelated requester continuation",
        now: NOW,
      });
      coordinationV3.markPromptSubmitted({
        injectionId: nextRun.injectionId,
        runId: nextRun.runId,
        fencingToken: nextRun.fencingToken,
        providerSessionId: "provider-requester",
        now: NOW,
      });
      coordinationV3.acknowledgePromptInjection({
        injectionId: nextRun.injectionId,
        runId: nextRun.runId,
        fencingToken: nextRun.fencingToken,
        providerSessionId: "provider-requester",
        now: NOW,
      });
      coordinationV3.completeRun(nextRun.runId, nextRun.fencingToken, NOW);
      nextRun = coordinationV3.leaseNextRun({ workerId: "next", now: NOW });
    }
    if (!nextRun) throw new Error("next ordinary Run was not leased");
    coordinationV3.markRunStarted(nextRun.runId, nextRun.fencingToken, NOW);
    const nextPrepared = await prepareRun(nextRun, "Use the accepted replacement session.");

    expect(nextPrepared.resumeSessionId).toBe("provider-new");
    expect(nextPrepared.providerInputManifest.artifactIds.sort())
      .toEqual([pinnedArtifactId, publishedArtifactId].sort());
    expect(nextPrepared.providerInputManifest.sources.filter((source) => source.kind === "artifact"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: pinnedArtifactId, delivery: "submitted" }),
        expect.objectContaining({ ref: publishedArtifactId, delivery: "submitted" }),
      ]));
    expect(nextPrepared.providerInputManifest.sources.some((source) =>
      source.kind === "history_message" && "delivery" in source && source.delivery === "submitted"
    )).toBe(true);
    expect(nextPrepared.exactProviderInput).toContain("Pinned or published project artifacts");
    expect(nextPrepared.exactProviderInput).toContain(publishedArtifactId);
    expect(nextPrepared.exactProviderInput).toContain(pinnedArtifactId);
    expect(nextPrepared.manifestArtifactIds.sort())
      .toEqual([pinnedArtifactId, publishedArtifactId].sort());
    expect(nextPrepared.freshProviderInputManifest.artifactIds.sort())
      .toEqual([pinnedArtifactId, publishedArtifactId].sort());
    expect(nextPrepared.freshExactProviderInput).toContain(publishedArtifactId);
    expect(nextPrepared.freshExactProviderInput).toContain(pinnedArtifactId);

    coordinationV3.preparePromptInjection({
      injectionId: nextRun.injectionId,
      runId: nextRun.runId,
      fencingToken: nextRun.fencingToken,
      prompt: nextPrepared.exactProviderInput,
      now: NOW,
    });
    coordinationV3.markPromptSubmitted({
      injectionId: nextRun.injectionId,
      runId: nextRun.runId,
      fencingToken: nextRun.fencingToken,
      providerSessionId: "provider-new",
      now: NOW,
    });
    coordinationV3.acknowledgePromptInjection({
      injectionId: nextRun.injectionId,
      runId: nextRun.runId,
      fencingToken: nextRun.fencingToken,
      providerSessionId: "provider-new",
      now: NOW,
    });
    store.appendEvent(agent.id, {
      type: "session_snapshot",
      sessionId: "provider-new",
      executionId: nextRun.runId,
      toolContractHash: nextPrepared.runtimeSessionContractHash,
      artifactIds: nextPrepared.manifestArtifactIds,
    });
    coordinationV3.completeRun(nextRun.runId, nextRun.fencingToken, NOW);

    coordinationV3.coordinate({
      projectId: project.id,
      conversationId,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "retained-artifact-follow-up",
      requests: [{
        recipientAgentId: agent.id,
        lifetime: { kind: "indefinite" },
        payload: { text: "Continue without replaying artifact context." },
      }],
    }, NOW);
    let retainedRun = coordinationV3.leaseNextRun({ workerId: "retained", now: NOW });
    while (retainedRun && retainedRun.agentId !== agent.id) {
      coordinationV3.markRunStarted(retainedRun.runId, retainedRun.fencingToken, NOW);
      coordinationV3.preparePromptInjection({
        injectionId: retainedRun.injectionId,
        runId: retainedRun.runId,
        fencingToken: retainedRun.fencingToken,
        prompt: "settle unrelated requester continuation",
        now: NOW,
      });
      coordinationV3.markPromptSubmitted({
        injectionId: retainedRun.injectionId,
        runId: retainedRun.runId,
        fencingToken: retainedRun.fencingToken,
        providerSessionId: "provider-requester",
        now: NOW,
      });
      coordinationV3.acknowledgePromptInjection({
        injectionId: retainedRun.injectionId,
        runId: retainedRun.runId,
        fencingToken: retainedRun.fencingToken,
        providerSessionId: "provider-requester",
        now: NOW,
      });
      coordinationV3.completeRun(retainedRun.runId, retainedRun.fencingToken, NOW);
      retainedRun = coordinationV3.leaseNextRun({ workerId: "retained", now: NOW });
    }
    if (!retainedRun) throw new Error("retained ordinary Run was not leased");
    coordinationV3.markRunStarted(retainedRun.runId, retainedRun.fencingToken, NOW);
    const retainedPrepared = await prepareRun(retainedRun, "Continue without replaying artifact context.");
    expect(retainedPrepared.exactProviderInput).not.toContain("Pinned or published project artifacts");
    expect(retainedPrepared.providerInputManifest.sources.filter((source) => source.kind === "artifact"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: pinnedArtifactId, delivery: "retained_session" }),
        expect.objectContaining({ ref: publishedArtifactId, delivery: "retained_session" }),
      ]));
    expect(store.getProjectContextArtifacts(project.id).map((item) => item.id).sort())
      .toEqual([pinnedArtifactId, publishedArtifactId].sort());
  });
});
