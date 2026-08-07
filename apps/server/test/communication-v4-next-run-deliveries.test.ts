import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Adapter,
  AgentEvent,
  ContinueOptions,
  OpenRuntimeSessionOptions,
  RuntimeSession,
  SeedOptions,
} from "@ponderosa/core";
import {
  AgentStore,
  CoordinationV3Store,
  type CommunicationV4NextRunDelivery,
} from "@ponderosa/agents";
import { createServer } from "../src/app.js";
import {
  NEXT_RUN_DELIVERY_BATCH_LIMIT,
  NEXT_RUN_DELIVERY_INLINE_CHARACTER_LIMIT,
  NEXT_RUN_DELIVERY_PROMPT_UTF8_BYTE_LIMIT,
  compileNextRunDeliveryBatch,
  renderNextRunDeliveryContext,
} from "../src/routes/agent-run-preparation.js";
import { CoordinationV3Scheduler } from "../src/coordination-v3-scheduler.js";

class NextRunDeliveryFixtureAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "V4 Next-run delivery fixture";
  readonly trustedSystemPromptChannel = "developer" as const;
  publisherId = "";
  recipientId = "";
  deliveryResult?: { success: boolean; text: string };
  coordinateResult?: { success: boolean; text: string };
  publisherAction: "next_run" | "coordinate" = "next_run";
  recipientPrompt?: string;
  recipientPrompts: string[] = [];
  recipientFailuresRemaining = 0;
  dynamicToolNames: string[] = [];
  dynamicToolHistory: string[][] = [];
  resumeSessionIds: Array<string | undefined> = [];
  attemptUnavailableResult = false;
  unavailableResult?: { success: boolean; text: string };
  resultQuery?: string;
  resultQueryResult?: { success: boolean; text: string };
  resultQueryResults: Array<{ success: boolean; text: string }> = [];

  listModels() { return [{ id: "test-model", label: "Test model" }]; }
  listEfforts() { return [{ id: "low", label: "Low" }]; }
  async *seed(_options: SeedOptions): AsyncIterable<AgentEvent> {
    throw new Error("Next-run delivery fixture must use a persistent runtime session");
  }
  async *continue(_options: ContinueOptions): AsyncIterable<AgentEvent> {
    throw new Error("Next-run delivery fixture must use a persistent runtime session");
  }

  async openSession(options: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.dynamicToolNames = (options.dynamicTools ?? []).map((tool) => tool.name);
    this.dynamicToolHistory.push(this.dynamicToolNames);
    this.resumeSessionIds.push(options.resumeSessionId);
    let turnInput: { prompt: string } | undefined;
    let startTurn!: () => void;
    const started = new Promise<void>((resolve) => { startTurn = resolve; });
    let finishClose!: () => void;
    const closed = new Promise<void>((resolve) => { finishClose = resolve; });
    let alive = true;
    const fixture = this;
    const session: RuntimeSession = {
      engineAgentId: `next-run-delivery-session:${options.agentId}`,
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          yield { type: "session", sessionId: `next-run-delivery-session:${options.agentId}` };
          await started;
          if (options.agentId === fixture.publisherId) {
            if (fixture.publisherAction === "coordinate") {
              fixture.coordinateResult = await options.handleDynamicToolCall?.({
                name: "ponderosa_coordinate",
                arguments: {
                  recipientAgentId: fixture.recipientId,
                  text: "Return a tracked rollback plan.",
                  completionMode: "record",
                  lifetime: { kind: "deadline", at: "2026-08-07T23:59:59Z" },
                },
              });
            } else {
              fixture.deliveryResult = await options.handleDynamicToolCall?.({
                name: "ponderosa_message",
                arguments: {
                  delivery: "next_run",
                  text: "Require hardware-backed authentication for privileged access.",
                  recipientAgentIds: [fixture.recipientId],
                },
              });
            }
          } else if (options.agentId === fixture.recipientId) {
            fixture.recipientPrompt = turnInput?.prompt;
            fixture.recipientPrompts.push(turnInput?.prompt ?? "");
            if (fixture.resultQuery) {
              const ref = /Full message:\s*(ponderosa:\/\/artifact\/[^\s]+)/u.exec(turnInput?.prompt ?? "")?.[1];
              if (!ref) throw new Error("result query fixture did not receive a full-message reference");
              let cursor: string | undefined;
              do {
                const result = await options.handleDynamicToolCall?.({
                  name: "ponderosa_result",
                  arguments: { refs: [ref], query: fixture.resultQuery, ...(cursor ? { cursor } : {}) },
                });
                if (!result) break;
                fixture.resultQueryResult ??= result;
                fixture.resultQueryResults.push(result);
                const parsed = result.success ? JSON.parse(result.text) as { nextCursor?: string } : {};
                cursor = parsed.nextCursor;
              } while (cursor && fixture.resultQueryResults.length < 10);
            }
            if (fixture.attemptUnavailableResult) {
              fixture.unavailableResult = await options.handleDynamicToolCall?.({
                name: "ponderosa_result",
                arguments: { refs: ["ponderosa://activation/not-reachable"] },
              });
            }
            if (fixture.recipientFailuresRemaining > 0) {
              fixture.recipientFailuresRemaining -= 1;
              throw new Error("simulated provider failure after prompt submission");
            }
          }
          yield { type: "turn_done" };
          await closed;
        },
      },
      startTurn: async (input) => {
        turnInput = input;
        startTurn();
        return { turnId: `turn:${options.agentId}` };
      },
      steer: async () => ({ status: "not_active" }),
      interrupt: async () => undefined,
      isAlive: () => alive,
      close: async () => {
        alive = false;
        finishClose();
      },
    };
    options.onRuntimeSpawned(session);
    return session;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

function deliveryFixture(index: number, text = `finding-${index}`): CommunicationV4NextRunDelivery {
  return {
    id: `delivery-${index.toString().padStart(2, "0")}`,
    projectId: "project",
    conversationId: "conversation",
    publisherKind: "agent",
    publisherAgentId: "publisher",
    publisherLabel: "Publisher",
    sourceRunId: "source-run",
    text,
    recipientAgentIds: ["recipient"],
    createdAt: `2026-08-07T00:00:${index.toString().padStart(2, "0")}.000Z`,
  };
}

describe("Communication V4 next-run delivery provider path", () => {
  let dataDir: string;
  let repoDir: string;
  let store: AgentStore;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-v4-next-run-"));
    repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-v4-project-"));
    store = new AgentStore(dataDir);
  });

  afterEach(async () => {
    await app?.close().catch(() => undefined);
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("compiles deterministic bounded batches with explicit row and character overflow", () => {
    const rowOverflow = compileNextRunDeliveryBatch(
      Array.from({ length: NEXT_RUN_DELIVERY_BATCH_LIMIT + 5 }, (_, index) =>
        deliveryFixture(index)),
    );
    expect(rowOverflow.deliveries.map(({ delivery }) => delivery.id)).toEqual(
      Array.from({ length: NEXT_RUN_DELIVERY_BATCH_LIMIT }, (_, index) => deliveryFixture(index).id),
    );
    expect(rowOverflow).toMatchObject({
      hasMore: true,
      nextPendingDeliveryId: deliveryFixture(NEXT_RUN_DELIVERY_BATCH_LIMIT).id,
    });

    const characterOverflow = compileNextRunDeliveryBatch(
      Array.from({ length: 5 }, (_, index) => deliveryFixture(index, "x".repeat(5_000))),
    );
    expect(characterOverflow.deliveries).toHaveLength(4);
    expect(characterOverflow.deliveries.reduce(
      (total, { inlineText }) => total + inlineText.length,
      0,
    )).toBe(NEXT_RUN_DELIVERY_INLINE_CHARACTER_LIMIT);
    expect(characterOverflow).toMatchObject({
      hasMore: true,
      nextPendingDeliveryId: deliveryFixture(4).id,
    });

    const unicodeBounded = compileNextRunDeliveryBatch(
      Array.from({ length: 4 }, (_, index) => deliveryFixture(index, "😀".repeat(5_000))),
    );
    expect(unicodeBounded.deliveries).toHaveLength(4);
    expect(Buffer.byteLength(renderNextRunDeliveryContext(unicodeBounded), "utf8"))
      .toBeLessThanOrEqual(NEXT_RUN_DELIVERY_PROMPT_UTF8_BYTE_LIMIT);
  });

  it.each([
    { label: "ordinary", historyCount: 0, textSize: 20, expected: [] },
    { label: "result reference", historyCount: 0, textSize: 8_000, expected: ["ponderosa_result"] },
    { label: "older context", historyCount: 41, textSize: 20, expected: ["ponderosa_context"] },
    { label: "both references", historyCount: 41, textSize: 8_000, expected: ["ponderosa_result", "ponderosa_context"] },
  ])("compiles the exact conditional retrieval tools for a $label Run", async ({ historyCount, textSize, expected }) => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "Conditional retrieval tools",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Conditional recipient",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = "not-this-agent";
    adapter.recipientId = agent.id;
    for (let index = 0; index < historyCount; index += 1) {
      const eventId = `history-${index}`;
      store.appendCommunicationEvent({
        eventId,
        schemaVersion: 2,
        projectId: project.id,
        conversationId,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
        text: `Historical message ${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 6, 0, 0, index)).toISOString(),
      });
      store.appendEvent(agent.id, {
        type: "user_message",
        text: `Historical message ${index}`,
        communicationEventId: eventId,
      });
    }
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "x".repeat(textSize),
        recipients: [{ agentId: agent.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => adapter.recipientPrompt !== undefined);
    const conditional = adapter.dynamicToolNames.filter((name) =>
      name === "ponderosa_result" || name === "ponderosa_context");
    expect(conditional).toEqual(expected);
    expect(adapter.recipientPrompt!.includes("OLDER SCOPED CONTEXT")).toBe(historyCount > 40);
  });

  it("rolls the provider session safely across false→true→false result availability", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "Alternating result availability",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Alternating recipient",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = "not-this-agent";
    adapter.recipientId = agent.id;
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });
    const submit = async (text: string, expectedSessions: number) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/direct-messages`,
        payload: {
          text,
          recipients: [{ agentId: agent.id }],
          idempotencyKey: randomUUID(),
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      await waitFor(() => adapter.dynamicToolHistory.length === expectedSessions);
    };

    await submit("ordinary", 1);
    await submit("x".repeat(8_000), 2);
    await submit("ordinary again", 3);

    expect(adapter.dynamicToolHistory.map((tools) => tools.includes("ponderosa_result")))
      .toEqual([false, true, false]);
    expect(adapter.resumeSessionIds).toEqual([undefined, undefined, undefined]);
  });

  it("keeps a UTF-8-bounded operator prefix and retrieves literal query excerpts from the durable full message", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "Bounded message retrieval",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Retrieval recipient",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = "not-this-agent";
    adapter.recipientId = agent.id;
    adapter.resultQuery = "NeEdLe[42]";
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });

    const text = `${"a".repeat(3_999)}😀${"b".repeat(5_000)}${Array.from({ length: 25 }, (_, index) => `needle[42]-${index} `).join("")}${"c".repeat(2_000)}`;
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text,
        recipients: [{ agentId: agent.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => adapter.resultQueryResult !== undefined);
    expect(adapter.recipientPrompt).toContain("Message preview (first 4,000 UTF-8 bytes):");
    expect(adapter.recipientPrompt).toContain("a".repeat(3_999));
    expect(adapter.recipientPrompt).not.toContain("😀");
    expect(adapter.recipientPrompt).not.toContain("needle[42]");
    expect(adapter.recipientPrompt).toMatch(/Full message: ponderosa:\/\/artifact\//u);
    expect(adapter.resultQueryResult?.success, adapter.resultQueryResult?.text).toBe(true);
    const result = JSON.parse(adapter.resultQueryResult!.text) as {
      matching: string;
      complete: boolean;
      matches: Array<{
        match: string;
        matchRange: { startUtf8Byte: number; endUtf8Byte: number };
        excerpt: string;
      }>;
    };
    expect(result).toMatchObject({ matching: "case_insensitive_literal", complete: false });
    expect(result.matches).toHaveLength(20);
    expect(result.matches[0]!.match).toBe("needle[42]");
    expect(result.matches[0]!.excerpt).toContain("needle[42]");
    expect(result.matches[0]!.matchRange.endUtf8Byte - result.matches[0]!.matchRange.startUtf8Byte)
      .toBe(Buffer.byteLength("needle[42]", "utf8"));
    await waitFor(() => adapter.resultQueryResults.length === 2);
    const secondPage = JSON.parse(adapter.resultQueryResults[1]!.text) as {
      complete: boolean;
      matches: Array<{ match: string }>;
    };
    expect(secondPage.complete).toBe(true);
    expect(secondPage.matches).toHaveLength(5);
    expect(secondPage.matches.every((match) => match.match === "needle[42]")).toBe(true);
  });

  it("fails closed when an absent conditional tool is invoked by a stale provider client", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "Absent tool fail closed",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Ordinary recipient",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = "not-this-agent";
    adapter.recipientId = agent.id;
    adapter.attemptUnavailableResult = true;
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Ordinary bounded turn",
        recipients: [{ agentId: agent.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => adapter.unavailableResult !== undefined);
    expect(adapter.unavailableResult).toEqual({
      success: false,
      text: "Unavailable Ponderosa tool for this Run: ponderosa_result",
    });
  });

  it("publishes through the provider tool and injects next-run state exactly once", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "V4 next-run delivery integration",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const publisher = store.createAgent(project.id, {
      title: "Security",
      engine: adapter.id,
      conversationId,
    });
    const recipient = store.createAgent(project.id, {
      title: "Implementation",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = publisher.id;
    adapter.recipientId = recipient.id;
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });

    const publisherMessage = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Publish the material security constraint without requesting a reply.",
        recipients: [{ agentId: publisher.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(publisherMessage.statusCode, publisherMessage.body).toBe(200);
    await waitFor(() => Boolean(adapter.deliveryResult));
    expect(adapter.dynamicToolNames).toContain("ponderosa_message");
    expect(adapter.dynamicToolNames).not.toContain("ponderosa_signal");
    expect(adapter.dynamicToolNames).not.toContain("ponderosa_result");
    expect(adapter.dynamicToolNames).not.toContain("ponderosa_context");
    expect(adapter.deliveryResult, adapter.deliveryResult?.text).toMatchObject({ success: true });
    const published = JSON.parse(adapter.deliveryResult!.text) as {
      delivery: "next_run";
      deliveryId: string;
    };
    expect(published.delivery).toBe("next_run");
    expect(store.sqlite.prepare(`
      SELECT state FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(published.deliveryId, recipient.id)).toEqual({ state: "pending" });

    const recipientMessage = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Implement the next authorized task.",
        recipients: [{ agentId: recipient.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(recipientMessage.statusCode, recipientMessage.body).toBe(200);
    await waitFor(() => Boolean(adapter.recipientPrompt));
    expect(adapter.recipientPrompt).toContain("NEXT-RUN INFORMATION · PASSIVE DELIVERY");
    expect(adapter.recipientPrompt).toContain("Require hardware-backed authentication");
    await waitFor(() => {
      const row = store.sqlite.prepare(`
        SELECT state FROM communication_v4_next_run_recipients
        WHERE delivery_id = ? AND agent_id = ?
      `).get(published.deliveryId, recipient.id) as { state: string } | undefined;
      return row?.state === "delivered";
    });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM json_each((SELECT source_manifest_json FROM provider_inputs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1), '$.sources') source
      WHERE json_extract(source.value, '$.ref') = ?
    `).get(recipient.id, `ponderosa://next-run-delivery/${published.deliveryId}`)).toEqual({ count: 1 });
  });

  it("delivers more than twenty pending deliveries across explicit restart-safe batches", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "V4 next-run delivery fan-in",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const publisher = store.createAgent(project.id, {
      title: "Research",
      engine: adapter.id,
      conversationId,
    });
    const recipient = store.createAgent(project.id, {
      title: "Synthesis",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = publisher.id;
    adapter.recipientId = recipient.id;

    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.enqueueMessageActivation({
      projectId: project.id,
      agentId: publisher.id,
      scopeKey: `conversation:${conversationId}`,
      messageId: "fan-in-publication",
      kind: "ordinary",
      payload: { text: "Publish the fan-in findings." },
    });
    const sourceRun = coordination.leaseNextRun({ workerId: "fan-in-publisher" })!;
    coordination.preparePromptInjection({
      injectionId: sourceRun.injectionId,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      prompt: "Publish bounded Next-run delivery fixtures.",
    });
    coordination.markRunStarted(sourceRun.runId, sourceRun.fencingToken);
    coordination.markPromptSubmitted({
      injectionId: sourceRun.injectionId,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      providerSessionId: "fan-in-publisher-session",
    });
    coordination.acknowledgePromptInjection({
      injectionId: sourceRun.injectionId,
      runId: sourceRun.runId,
      fencingToken: sourceRun.fencingToken,
      providerSessionId: "fan-in-publisher-session",
      providerTurnId: "fan-in-publisher-turn",
    });
    const published = Array.from({ length: 25 }, (_, index) =>
      coordination.publishAgentNextRunDelivery({
        projectId: project.id,
        conversationId,
        publisherAgentId: publisher.id,
        sourceRunId: sourceRun.runId,
        runAuthorization: {
          runId: sourceRun.runId,
          agentId: publisher.id,
          fencingToken: sourceRun.fencingToken,
        },
        idempotencyKey: `fan-in-${index}`,
        text: `material-finding-${index.toString().padStart(2, "0")}`,
        recipientAgentIds: [recipient.id],
        now: `2026-08-07T00:00:${index.toString().padStart(2, "0")}.000Z`,
      }).delivery);
    coordination.cancelAgentRun({
      agentId: publisher.id,
      expectedRunId: sourceRun.runId,
      idempotencyKey: "finish-fan-in-publication",
    });

    const startApp = () => createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });
    app = startApp();
    const first = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Synthesize the first bounded batch.",
        recipients: [{ agentId: recipient.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    await waitFor(() => adapter.recipientPrompts.length === 1);
    expect(adapter.recipientPrompts[0]).toContain("- batchCount: 20");
    expect(adapter.recipientPrompts[0]).toContain("- hasMore: true");
    expect(adapter.recipientPrompts[0]).toContain(
      `- nextPendingDeliveryId: ${published[NEXT_RUN_DELIVERY_BATCH_LIMIT]!.id}`,
    );
    expect(adapter.recipientPrompts[0]).not.toContain("material-finding-20");
    await waitFor(() => {
      const counts = store.sqlite.prepare(`
        SELECT state, COUNT(*) AS count
        FROM communication_v4_next_run_recipients
        WHERE agent_id = ?
        GROUP BY state
      `).all(recipient.id) as Array<{ state: string; count: number }>;
      return counts.some(({ state, count }) => state === "delivered" && count === 20) &&
        counts.some(({ state, count }) => state === "pending" && count === 5);
    });

    await app.close();
    store = new AgentStore(dataDir);
    app = startApp();
    const second = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Continue synthesis with the remaining pending batch.",
        recipients: [{ agentId: recipient.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(second.statusCode, second.body).toBe(200);
    await waitFor(() => adapter.recipientPrompts.length === 2);
    expect(adapter.recipientPrompts[1]).toContain("- batchCount: 5");
    expect(adapter.recipientPrompts[1]).toContain("- hasMore: false");
    expect(adapter.recipientPrompts[1]).toContain("material-finding-20");
    expect(adapter.recipientPrompts[1]).toContain("material-finding-24");
    await waitFor(() => {
      const delivered = store.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM communication_v4_next_run_recipients
        WHERE agent_id = ? AND state = 'delivered'
      `).get(recipient.id) as { count: number };
      return delivered.count === 25;
    });

    const manifests = store.sqlite.prepare(`
      SELECT source_manifest_json FROM provider_inputs
      WHERE agent_id = ?
      ORDER BY rowid
    `).all(recipient.id) as Array<{ source_manifest_json: string }>;
    const deliveryRefs = manifests.map(({ source_manifest_json }) =>
      (JSON.parse(source_manifest_json) as {
        sources: Array<{ ref: string }>;
      }).sources.filter(({ ref }) => ref.startsWith("ponderosa://next-run-delivery/")));
    expect(deliveryRefs.map((refs) => refs.length)).toEqual([20, 5]);
    expect(new Set(deliveryRefs.flat().map(({ ref }) => ref)).size).toBe(25);
  });

  it("reconciles only the completed manifest on scheduler restart and stores scheduler Run identity", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "V4 next-run delivery crash reconciliation",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const publisher = store.createAgent(project.id, {
      title: "Research",
      engine: adapter.id,
      conversationId,
    });
    const recipient = store.createAgent(project.id, {
      title: "Synthesis",
      engine: adapter.id,
      conversationId,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    const publish = (messageId: string, idempotencyKey: string) => {
      coordination.enqueueMessageActivation({
        projectId: project.id,
        agentId: publisher.id,
        scopeKey: `conversation:${conversationId}`,
        messageId,
        kind: "ordinary",
        payload: { text: `Publish ${idempotencyKey}.` },
      });
      const lease = coordination.leaseNextRun({ workerId: `publisher-${idempotencyKey}` })!;
      coordination.preparePromptInjection({
        injectionId: lease.injectionId,
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        prompt: `Publish ${idempotencyKey}.`,
      });
      coordination.markRunStarted(lease.runId, lease.fencingToken);
      coordination.markPromptSubmitted({
        injectionId: lease.injectionId,
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        providerSessionId: `publisher-session-${idempotencyKey}`,
      });
      coordination.acknowledgePromptInjection({
        injectionId: lease.injectionId,
        runId: lease.runId,
        fencingToken: lease.fencingToken,
        providerSessionId: `publisher-session-${idempotencyKey}`,
        providerTurnId: `publisher-turn-${idempotencyKey}`,
      });
      const delivery = coordination.publishAgentNextRunDelivery({
        projectId: project.id,
        conversationId,
        publisherAgentId: publisher.id,
        sourceRunId: lease.runId,
        runAuthorization: {
          runId: lease.runId,
          agentId: publisher.id,
          fencingToken: lease.fencingToken,
        },
        idempotencyKey,
        text: `Finding ${idempotencyKey}`,
        recipientAgentIds: [recipient.id],
      }).delivery;
      coordination.cancelAgentRun({
        agentId: publisher.id,
        expectedRunId: lease.runId,
        idempotencyKey: `finish-${idempotencyKey}`,
      });
      return delivery;
    };

    const manifested = publish("manifested-publication", "manifested");
    coordination.enqueueMessageActivation({
      projectId: project.id,
      agentId: recipient.id,
      scopeKey: `conversation:${conversationId}`,
      messageId: "recipient-work",
      kind: "ordinary",
      payload: { text: "Synthesize the manifested finding." },
    });
    const recipientLease = coordination.leaseNextRun({ workerId: "recipient-worker" })!;
    coordination.preparePromptInjection({
      injectionId: recipientLease.injectionId,
      runId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      prompt: "Synthesize the manifested finding.",
    });
    coordination.markRunStarted(recipientLease.runId, recipientLease.fencingToken);
    coordination.markPromptSubmitted({
      injectionId: recipientLease.injectionId,
      runId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      providerSessionId: "recipient-session",
    });
    coordination.acknowledgePromptInjection({
      injectionId: recipientLease.injectionId,
      runId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      providerSessionId: "recipient-session",
      providerTurnId: "recipient-turn",
    });
    coordination.recordProviderInput({
      executionId: "recipient-provider-execution",
      schedulerRunId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      agentId: recipient.id,
      projectId: project.id,
      prompt: "Synthesize the manifested finding.",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: recipientLease.activationIds,
        communicationEventIds: [],
        artifactIds: [],
        providerSessionDisposition: "fresh_task",
        sources: [{
          kind: "context_reference",
          ref: `ponderosa://next-run-delivery/${manifested.id}`,
        }],
      },
    });

    const publishedAfterManifest = publish("late-publication", "late");
    coordination.completeRun(recipientLease.runId, recipientLease.fencingToken,
      "2026-08-07T03:00:00.000Z");
    expect(store.sqlite.prepare(`
      SELECT state FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(manifested.id, recipient.id)).toEqual({ state: "pending" });

    const scheduler = new CoordinationV3Scheduler(
      coordination,
      async () => ({ accepted: true }),
      { workerId: "restart-reconciler", pollMs: 60_000 },
    );
    scheduler.start();
    await scheduler.stop();

    expect(store.sqlite.prepare(`
      SELECT state, delivered_run_id AS deliveredRunId
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(manifested.id, recipient.id)).toEqual({
      state: "delivered",
      deliveredRunId: recipientLease.runId,
    });
    expect(store.sqlite.prepare(`
      SELECT state, delivered_run_id AS deliveredRunId
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(publishedAfterManifest.id, recipient.id)).toEqual({
      state: "pending",
      deliveredRunId: null,
    });
  });

  it("redelivers next-run state after a submitted provider turn fails", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "V4 next-run delivery recovery",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const publisher = store.createAgent(project.id, {
      title: "Research",
      engine: adapter.id,
      conversationId,
    });
    const recipient = store.createAgent(project.id, {
      title: "Synthesis",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = publisher.id;
    adapter.recipientId = recipient.id;
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });

    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Publish the research constraint.",
        recipients: [{ agentId: publisher.id }],
        idempotencyKey: randomUUID(),
      },
    });
    await waitFor(() => Boolean(adapter.deliveryResult));
    const deliveryId = (JSON.parse(adapter.deliveryResult!.text) as {
      deliveryId: string;
    }).deliveryId;

    adapter.recipientFailuresRemaining = 1;
    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "First synthesis attempt.",
        recipients: [{ agentId: recipient.id }],
        idempotencyKey: randomUUID(),
      },
    });
    await waitFor(() => adapter.recipientPrompts.length === 1);
    await waitFor(() => {
      const active = store.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM scheduler_runs
        WHERE agent_id = ? AND status IN ('leased', 'running')
      `).get(recipient.id) as { count: number };
      return active.count === 0;
    });
    expect(store.sqlite.prepare(`
      SELECT state FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(deliveryId, recipient.id)).toEqual({ state: "pending" });

    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Retry synthesis after the failed provider turn.",
        recipients: [{ agentId: recipient.id }],
        idempotencyKey: randomUUID(),
      },
    });
    await waitFor(() => adapter.recipientPrompts.length === 2);
    expect(adapter.recipientPrompts[0]).toContain("Require hardware-backed authentication");
    expect(adapter.recipientPrompts[1]).toContain("Require hardware-backed authentication");
    await waitFor(() => {
      const delivery = store.sqlite.prepare(`
        SELECT state FROM communication_v4_next_run_recipients
        WHERE delivery_id = ? AND agent_id = ?
      `).get(deliveryId, recipient.id) as { state: string } | undefined;
      return delivery?.state === "delivered";
    });
  });

  it("persists the provider-visible common Request lifetime as a real deadline", async () => {
    const adapter = new NextRunDeliveryFixtureAdapter();
    const project = store.createProject({
      label: "Common Request lifetime",
      hostPath: repoDir,
      defaultEngine: adapter.id,
    });
    const conversationId = project.lastConversationId!;
    const publisher = store.createAgent(project.id, {
      title: "Planner",
      engine: adapter.id,
      conversationId,
    });
    const recipient = store.createAgent(project.id, {
      title: "Operations",
      engine: adapter.id,
      conversationId,
    });
    adapter.publisherId = publisher.id;
    adapter.recipientId = recipient.id;
    adapter.publisherAction = "coordinate";
    app = createServer({
      dataDir,
      store,
      engines: [{
        adapter,
        authStatus: async () => ({ authenticated: true, detail: "test subscription" }),
      }],
      logger: false,
      communicationV3: { pollMs: 5 },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/direct-messages`,
      payload: {
        text: "Assign the tracked rollback plan with its deadline.",
        recipients: [{ agentId: publisher.id }],
        idempotencyKey: randomUUID(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await waitFor(() => Boolean(adapter.coordinateResult));
    expect(adapter.dynamicToolNames).toContain("ponderosa_coordinate");
    expect(adapter.coordinateResult).toMatchObject({ success: true });
    expect(store.sqlite.prepare(`
      SELECT lifetime_kind AS lifetimeKind, deadline_at AS deadlineAt
      FROM coordination_requests
      WHERE project_id = ? AND requester_agent_id = ? AND recipient_agent_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(project.id, publisher.id, recipient.id)).toEqual({
      lifetimeKind: "deadline",
      deadlineAt: "2026-08-07T23:59:59Z",
    });
  });
});
