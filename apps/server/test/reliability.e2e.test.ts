import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, EffortOption, ModelOption, SeedOptions } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { createServer } from "../src/app.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Controlled runtime";
  readonly seedStarted = deferred<SeedOptions>();
  readonly seedAborted = deferred();
  readonly continueStarted = deferred<ContinueOptions>();

  listModels(): ModelOption[] { return [{ id: "mock", label: "Mock" }]; }
  listEfforts(): EffortOption[] { return [{ id: "high", label: "High" }]; }

  async *seed(options: SeedOptions): AsyncIterable<AgentEvent> {
    yield { type: "session", sessionId: "controlled-session" };
    yield { type: "text", delta: "streamed first chunk" };
    this.seedStarted.resolve(options);
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    this.seedAborted.resolve();
  }

  async *continue(options: ContinueOptions): AsyncIterable<AgentEvent> {
    this.continueStarted.resolve(options);
    yield { type: "text", delta: "queued turn completed" };
    yield { type: "turn_done" };
  }
}

// Quarantine on non-Linux hosts: creating the exercised Agent currently fails
// closed at the managed artifact readiness gate.
describe.skipIf(process.platform !== "linux")("V1 reliability safety net", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

  it("creates a project/control room/agent, streams, queues, cancels, and drains without timers", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-reliability-data-"));
    const repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-reliability-repo-"));
    cleanup.push(dataDir, repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "fixture\n");
    const store = new AgentStore(dataDir);
    const adapter = new ControlledAdapter();
    const app = createServer({
      dataDir,
      store,
      engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }],
      allowedBrowseRoots: [repoDir],
      logger: false,
    });

    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { label: "Fixture", hostPath: repoDir, defaultEngine: "codex" },
    })).json<{ id: string }>();
    const master = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Control room", defaultEngine: "codex" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Reliability Agent", engine: "codex", conversationId: master.id, initialMessage: "first turn" },
    })).json<{ id: string }>();

    await adapter.seedStarted.promise;
    expect(store.readEvents(agent.id).map(({ event }) => event.type)).toEqual(
      expect.arrayContaining(["session", "text"]),
    );
    expect(store.getConversationMessages(master.id)).toContainEqual(expect.objectContaining({ text: "first turn" }));

    const queued = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "second turn" } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, position: 1, communicationEventId: expect.any(String) });

    const targetRunId = new CoordinationV3Store(store.sqlite).agentSnapshot(agent.id).activeRun!.id;
    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: { targetRunId, idempotencyKey: "reliability-stop" },
    })).json()).toEqual({ cancelled: true, replayed: false });
    await adapter.seedAborted.promise;
    const continued = await adapter.continueStarted.promise;
    expect(continued.prompt).toContain("second turn");
    expect(continued.resumeSessionId).toBe("controlled-session");
    expect(store.resumeSessionState(agent.id)).toMatchObject({
      sessionId: "controlled-session",
      toolContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    while (!store.readEvents(agent.id).some(({ event }) => event.type === "agent_output")) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const detail = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}` })).json<{
      messages: Array<{ role: string; text: string }>;
      runOutput: Array<{ executionId: string; kind: string; text: string; completed: boolean }>;
    }>();
    expect(detail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "second turn" }),
    ]));
    expect(detail.messages.some((message) => message.text === "queued turn completed")).toBe(false);
    expect(detail.runOutput).toEqual([
      expect.objectContaining({
        executionId: expect.any(String), kind: "response", text: "queued turn completed", completed: true,
      }),
    ]);
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.sender.kind === "agent" && event.text === "queued turn completed")).toBe(false);
    expect(store.readEvents(agent.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({
        type: "agent_output", executionId: detail.runOutput[0]!.executionId, text: "queued turn completed",
      }) }),
    ]));
    await app.close();
  });
});
