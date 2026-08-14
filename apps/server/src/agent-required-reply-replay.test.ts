import type {
  Adapter,
  OpenRuntimeSessionOptions,
  RuntimeSession,
} from "@ponderosa/core";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { processBirthMarker, recoveredRuntimeProcessHandle } from "@ponderosa/engines";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer } from "./app.js";
import { recoverRequiredReplyPublications } from "./routes/agent-message-run.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function replyAdapter(input: {
  replyingAgentId: string;
  store: AgentStore;
  resolveResults: (results: Array<{ success: boolean; text: string }>) => void;
}): Adapter {
  return {
    id: "codex",
    displayName: "Codex",
    trustedSystemPromptChannel: "developer",
    listModels: () => [{ id: "test-model", label: "Test model" }],
    listEfforts: () => [],
    openSession: async (options: OpenRuntimeSessionOptions): Promise<RuntimeSession> => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const birthMarker = processBirthMarker(child.pid!);
      if (!birthMarker) throw new Error("test provider process lacks birth evidence");
      const authority = recoveredRuntimeProcessHandle({
        pid: child.pid!,
        pgid: child.pid!,
        birthMarker,
      }, {
        label: `test provider ${options.agentId}`,
        termGraceMs: 1_000,
        killConfirmationMs: 1_000,
      });
      const session: RuntimeSession = {
        engineAgentId: `provider-${options.agentId}`,
        processIdentity: { pid: child.pid!, pgid: child.pid!, birthMarker },
        isAlive: () => authority.isAlive(),
        close: () => authority.close(),
        startTurn: async () => ({ turnId: `turn-${options.agentId}` }),
        steer: async () => ({ status: "unsupported", reason: "test runtime" }),
        interrupt: async () => undefined,
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, sessionId: `session-${options.agentId}` };
            if (options.agentId === input.replyingAgentId) {
              const first = await options.handleDynamicToolCall!({
                name: "ponderosa_message",
                arguments: { text: "Updated exactly-once reply." },
              });
              input.store.sqlite.exec("DROP TRIGGER fail_required_reply_relation_index");
              const second = await options.handleDynamicToolCall!({
                name: "ponderosa_message",
                arguments: { text: "Updated exactly-once reply." },
              });
              input.resolveResults([first, second]);
            }
            yield { type: "turn_done" as const };
          },
        },
      };
      options.onRuntimeSpawned(session);
      return session;
    },
    async *seed() { yield { type: "turn_done" }; },
    async *continue() { yield { type: "turn_done" }; },
  };
}

describe("required-reply canonical append replay", () => {
  test("keeps one durable reply identity across index failure, immediate retry, and restart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ponderosa-required-reply-replay-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const hostPath = path.join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: "Reply replay", hostPath, defaultEngine: "codex" });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, {
      title: "Reply Agent",
      engine: "codex",
      conversationId,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    coordination.recordRuntimeCommunication({
      id: "required-reply-source",
      projectId: project.id,
      scopeKey: `conversation:${conversationId}`,
      sender: { kind: "user", userId: "local-operator" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      payload: {
        communication: {
          schemaVersion: 2,
          eventId: "required-reply-source",
          projectId: project.id,
          conversationId,
          sender: { kind: "user", userId: "local-operator" },
          intent: "user_dm",
          audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
          text: "Reply exactly once.",
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      },
      activation: {
        agentId: agent.id,
        kind: "human_message",
        priority: 100,
        dispatchPolicy: "steer_or_run",
        promptClass: "human",
      },
      now: "2026-08-14T00:00:00.000Z",
    });
    store.sqlite.exec(`
      CREATE TRIGGER fail_required_reply_relation_index
      BEFORE INSERT ON compaction_history_relation_candidates
      BEGIN
        SELECT RAISE(FAIL, 'injected relation index failure');
      END
    `);
    let resolveResults!: (results: Array<{ success: boolean; text: string }>) => void;
    const results = new Promise<Array<{ success: boolean; text: string }>>((resolve) => {
      resolveResults = resolve;
    });
    const app = createServer({
      dataDir,
      store,
      engines: [{
        adapter: replyAdapter({ replyingAgentId: agent.id, store, resolveResults }),
        authStatus: async () => ({ authenticated: true }),
      }],
      communicationV3: { pollMs: 10 },
      logger: false,
    });
    await app.ready();
    const attemptResults = await results;
    expect(attemptResults).toHaveLength(2);
    const first = attemptResults[0]!;
    const second = attemptResults[1]!;
    expect(first.success).toBe(false);
    expect(first.text).toContain("injected relation index failure");
    expect(second.success, second.text).toBe(true);
    const secondResponse = JSON.parse(second.text) as { eventId: string; replayed: boolean };
    expect(secondResponse.replayed).toBe(true);

    await vi.waitFor(() => {
      expect(store.sqlite.prepare(`SELECT status FROM scheduler_runs`).get())
        .toEqual({ status: "completed" });
    }, { timeout: 5_000, interval: 20 });
    const authoredReplies = store.readCommunicationEvents(project.id).filter((event) =>
      event.sender.kind === "agent" && event.text === "Updated exactly-once reply.");
    expect(authoredReplies).toHaveLength(1);
    expect(authoredReplies[0]!.eventId).toBe(secondResponse.eventId);
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM required_reply_obligations
      WHERE state = 'satisfied' AND satisfied_communication_id = ?
    `).get(secondResponse.eventId)).toEqual({ count: 1 });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM compaction_history_fts fts
      JOIN compaction_history_messages message ON message.rowid = fts.rowid
      WHERE message.project_id = ? AND message.communication_event_id = ?
    `).get(project.id, secondResponse.eventId)).toEqual({ count: 1 });
    expect(store.getConversationMessages(conversationId, "main")
      .filter((message) => message.communicationEventId === secondResponse.eventId)).toHaveLength(1);
    expect(store.sqlite.prepare(`SELECT COUNT(*) AS count FROM scheduler_runs`).get())
      .toEqual({ count: 1 });

    const runId = authoredReplies[0]!.sender.kind === "agent"
      ? authoredReplies[0]!.sender.executionId!
      : "";
    await app.close();

    const restartedStore = new AgentStore(dataDir);
    const restartedCoordination = new CoordinationV3Store(restartedStore.sqlite);
    try {
      const recovered = recoverRequiredReplyPublications(restartedCoordination, runId, agent.id);
      expect(recovered.communicationEventId).toBe(secondResponse.eventId);
      expect(Object.values(recovered.fingerprints)).toHaveLength(1);
      expect(restartedStore.readCommunicationEvents(project.id).filter((event) =>
        event.sender.kind === "agent" && event.text === "Updated exactly-once reply.")).toHaveLength(1);
      expect(restartedStore.compactionHistoryIndexStats(project.id).lexicalRows).toBeGreaterThanOrEqual(1);
      expect(restartedStore.sqlite.prepare(`SELECT COUNT(*) AS count FROM scheduler_runs`).get())
        .toEqual({ count: 1 });
      expect(restartedStore.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM agent_activations
        WHERE kind = 'required_reply_recovery' AND state IN ('pending','retry_pending')
      `).get()).toEqual({ count: 0 });
    } finally {
      restartedStore.close();
    }
  }, 15_000);
});
