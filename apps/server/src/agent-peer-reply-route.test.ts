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
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./app.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function peerReplyAdapter(input: {
  replyingAgentId: string;
  resolveResult: (result: { success: boolean; text: string }) => void;
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
      const processIdentity = { pid: child.pid!, pgid: child.pid!, birthMarker };
      const authority = recoveredRuntimeProcessHandle(processIdentity, {
        label: `test provider ${options.agentId}`,
        termGraceMs: 1_000,
        killConfirmationMs: 1_000,
      });
      const session: RuntimeSession = {
        engineAgentId: `provider-${options.agentId}`,
        processIdentity,
        isAlive: () => authority.isAlive(),
        close: () => authority.close(),
        startTurn: async () => ({ turnId: `turn-${options.agentId}` }),
        steer: async () => ({ status: "unsupported", reason: "test runtime" }),
        interrupt: async () => undefined,
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, sessionId: `session-${options.agentId}` };
            if (options.agentId === input.replyingAgentId) {
              const result = await options.handleDynamicToolCall!({
                name: "ponderosa_message",
                arguments: { text: "Peer result" },
              });
              input.resolveResult(result);
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

async function peerReplyFixture(kind: "ordinary_message" | "urgent_message") {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-peer-reply-route-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const hostPath = path.join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(dataDir);
  const project = store.createProject({ label: "Peer reply", hostPath, defaultEngine: "codex" });
  const conversationId = project.lastConversationId!;
  const replyingAgent = store.createAgent(project.id, {
    title: "Replying Agent",
    engine: "codex",
    conversationId,
  });
  const peerAgent = store.createAgent(project.id, {
    title: "Peer Agent",
    engine: "codex",
    conversationId,
  });
  const coordination = new CoordinationV3Store(store.sqlite);
  const sourceCommunicationId = `peer-${kind}`;
  coordination.recordRuntimeCommunication({
    id: sourceCommunicationId,
    projectId: project.id,
    scopeKey: `conversation:${conversationId}`,
    sender: { kind: "agent", agentId: peerAgent.id },
    intent: "collaboration",
    audience: { kind: "agents", agentIds: [replyingAgent.id] },
    payload: {
      communication: {
        schemaVersion: 2,
        eventId: sourceCommunicationId,
        projectId: project.id,
        conversationId,
        sender: { kind: "agent", agentId: peerAgent.id },
        intent: "collaboration",
        audience: { kind: "agents", agentIds: [replyingAgent.id] },
        text: "Please send the result back.",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    },
    activation: {
      agentId: replyingAgent.id,
      kind,
      priority: kind === "urgent_message" ? 90 : 50,
      dispatchPolicy: kind === "urgent_message" ? "steer_or_run" : "next_run",
      promptClass: kind === "urgent_message" ? "blocker" : "ordinary",
      dedupeKey: sourceCommunicationId,
    },
    now: "2026-08-14T00:00:00.000Z",
  });
  let resolveResult!: (result: { success: boolean; text: string }) => void;
  const result = new Promise<{ success: boolean; text: string }>((resolve) => {
    resolveResult = resolve;
  });
  const app = createServer({
    dataDir,
    store,
    engines: [{
      adapter: peerReplyAdapter({ replyingAgentId: replyingAgent.id, resolveResult }),
      authStatus: async () => ({ authenticated: true }),
    }],
    communicationV3: { pollMs: 10 },
    logger: false,
  });
  await app.ready();
  return { app, coordination, store, peerAgent, result };
}

describe("peer-only inferred reply routes", () => {
  it.each(["ordinary_message", "urgent_message"] as const)(
    "lets %s use bare ponderosa_message without creating an obligation",
    async (kind) => {
      const fixture = await peerReplyFixture(kind);
      try {
        let timeout: NodeJS.Timeout | undefined;
        const toolResult = await Promise.race([
          fixture.result,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              const runs = fixture.store.sqlite.prepare(`
                SELECT status, provider_failure_json FROM scheduler_runs ORDER BY created_at
              `).all();
              reject(new Error(`peer reply route was not exercised: ${JSON.stringify(runs)}`));
            }, 3_000);
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        expect(toolResult.success).toBe(true);
        const response = JSON.parse(toolResult.text) as { intent?: string; eventId?: string };
        expect(response.intent).toBe("collaboration");
        expect(response.eventId).toBeTruthy();
        expect(fixture.coordination.runtimeCommunication(response.eventId!)?.audience).toEqual({
          kind: "agents",
          agentIds: [fixture.peerAgent.id],
        });
        expect(fixture.store.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM required_reply_obligations
        `).get()).toEqual({ count: 0 });
      } finally {
        await fixture.app.close();
      }
    },
    10_000,
  );
});
