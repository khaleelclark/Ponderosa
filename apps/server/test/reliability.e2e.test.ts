import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, EffortOption, ModelOption, SeedOptions } from "@ponderosa/core";
import { ThreadStore } from "@ponderosa/threads";
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

describe("V1 reliability safety net", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

  it("creates a project/control room/agent, streams, queues, cancels, and drains without timers", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-reliability-data-"));
    const repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-reliability-repo-"));
    cleanup.push(dataDir, repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "fixture\n");
    const store = new ThreadStore(dataDir);
    const adapter = new ControlledAdapter();
    const app = createServer({
      dataDir,
      store,
      engines: [{ adapter, authStatus: async () => ({ authenticated: true }) }],
      logger: false,
    });

    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { label: "Fixture", hostPath: repoDir },
    })).json<{ id: string }>();
    const master = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/master-chats`, payload: { title: "Control room", defaultEngine: "codex" },
    })).json<{ id: string }>();
    const thread = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads`,
      payload: { title: "Reliability Agent", engine: "codex", masterChatId: master.id, initialMessage: "first turn" },
    })).json<{ id: string }>();

    await adapter.seedStarted.promise;
    expect(store.readEvents(thread.id).map(({ event }) => event.type)).toEqual(
      expect.arrayContaining(["user_message", "session", "text"]),
    );

    const queued = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "second turn" } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toEqual({ queued: true, position: 1 });

    expect((await app.inject({ method: "POST", url: `/api/threads/${thread.id}/cancel` })).json()).toEqual({ cancelled: true });
    await adapter.seedAborted.promise;
    const continued = await adapter.continueStarted.promise;
    expect(continued.prompt).toContain("second turn");
    expect(continued.resumeSessionId).toBe("controlled-session");

    const detail = (await app.inject({ method: "GET", url: `/api/threads/${thread.id}` })).json<{
      messages: Array<{ role: string; text: string }>;
    }>();
    expect(detail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "first turn" }),
      expect.objectContaining({ role: "user", text: "second turn" }),
      expect.objectContaining({ role: "assistant", text: "queued turn completed" }),
    ]));
    await app.close();
  });
});
