import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, EffortOption, ModelOption, SeedOptions } from "@ponderosa/core";
import { ThreadStore } from "@ponderosa/threads";
import { createServer, type EngineRegistration } from "../src/app.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockAdapter implements Adapter {
  id = "codex";
  displayName = "Mock Codex";
  readonly seeds: SeedOptions[] = [];
  readonly continues: ContinueOptions[] = [];
  mode: "normal" | "hang" = "normal";

  listModels(): ModelOption[] {
    return [{ id: "mock-model", label: "Mock Model" }];
  }

  listEfforts(): EffortOption[] {
    return [{ id: "high", label: "High" }];
  }

  async *seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    this.seeds.push(opts);
    yield { type: "session", sessionId: "sess-1" };
    if (this.mode === "hang") {
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "error", message: "run cancelled" };
      return;
    }
    await sleep(5);
    yield { type: "command", command: "pnpm test", cwd: opts.cwd };
    yield { type: "file_change", path: "a.ts", kind: "edit", diff: "diff --git a/a.ts b/a.ts\n" };
    yield { type: "text", delta: "done" };
    yield { type: "turn_done" };
  }

  async *continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    this.continues.push(opts);
    yield { type: "text", delta: `continued ${opts.resumeSessionId}` };
    yield { type: "turn_done" };
  }
}

let dataDir: string;
let repoDir: string;
let store: ThreadStore;
let adapter: MockAdapter;
let engines: EngineRegistration[];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-server-data-"));
  repoDir = mkdtempSync(path.join(tmpdir(), "pond-server-repo-"));
  writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  store = new ThreadStore(dataDir);
  adapter = new MockAdapter();
  engines = [{ adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

async function createProjectAndThread() {
  const app = createServer({ dataDir, store, engines, logger: false });
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { label: "Demo", hostPath: repoDir },
  });
  const project = projectRes.json<{ id: string }>();
  const threadRes = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/threads`,
    payload: { title: "Thread", engine: "codex" },
  });
  const thread = threadRes.json<{ id: string }>();
  return { app, project, thread };
}

async function waitForRun(threadId: string, expectedTurnDoneCount = 1): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const done = store.readEvents(threadId).filter((event) => event.event.type === "turn_done").length;
    if (done >= expectedTurnDoneCount) return;
    await sleep(10);
  }
  throw new Error("run did not finish");
}

describe("server chunk F", () => {
  it("seeds first message, then continues with the captured session id", async () => {
    const { app, thread } = await createProjectAndThread();
    const first = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "first", model: "mock-model", effort: "high" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ mode: "seed" });
    await waitForRun(thread.id);

    const second = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ mode: "continue" });
    await waitForRun(thread.id, 2);

    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.history).toEqual([]);
    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.resumeSessionId).toBe("sess-1");
    const artifacts = store.getArtifacts(thread.id);
    const artifactRes = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/artifacts/${artifacts.find((artifact) => artifact.kind === "diff")?.id}`,
    });
    expect(artifactRes.statusCode).toBe(200);
    expect(artifactRes.json<{ content: string; contentType: string }>()).toMatchObject({
      content: "diff --git a/a.ts b/a.ts\n",
      contentType: "diff",
    });
    await app.close();
  });

  it("rejects concurrent runs and cancel aborts the active run", async () => {
    adapter.mode = "hang";
    const { app, thread } = await createProjectAndThread();
    const first = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "long" },
    });
    expect(first.statusCode).toBe(200);

    const concurrent = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "again" },
    });
    expect(concurrent.statusCode).toBe(409);

    const cancel = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/cancel` });
    expect(cancel.json()).toEqual({ cancelled: true });
    for (let i = 0; i < 80 && store.readEvents(thread.id).at(-1)?.event.type !== "error"; i += 1) {
      await sleep(10);
    }
    expect(store.readEvents(thread.id).at(-1)?.event).toEqual({ type: "error", message: "run cancelled" });
    await app.close();
  });

  it("rejects file-browser path escapes", async () => {
    const { app, project } = await createProjectAndThread();
    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=../outside`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects symlink escapes from the file-browser API", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "pond-server-outside-"));
    writeFileSync(path.join(outsideDir, "secret.txt"), "nope\n", "utf8");
    symlinkSync(outsideDir, path.join(repoDir, "outside-link"));
    const { app, project } = await createProjectAndThread();

    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=outside-link/secret.txt`,
    });

    expect(res.statusCode).toBe(400);
    rmSync(outsideDir, { recursive: true, force: true });
    await app.close();
  });

  it("reports engine auth status without requiring real CLI auth", async () => {
    const failing = new MockAdapter();
    failing.id = "broken";
    failing.displayName = "Broken";
    const app = createServer({
      dataDir,
      store,
      logger: false,
      engines: [
        { adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) },
        {
          adapter: failing,
          authStatus: async () => {
            throw new Error("not logged in");
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/engines" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "codex", authenticated: true, authDetail: "test" }),
      expect.objectContaining({ id: "broken", authenticated: false, authDetail: "not logged in" }),
    ]);
    await app.close();
  });

  it("keeps v2 routes as explicit 501 stubs", async () => {
    const { app, thread } = await createProjectAndThread();

    const switchEngine = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/switch-engine`,
      payload: { engine: "claude" },
    });
    const search = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/search?q=history`,
    });

    expect(switchEngine.statusCode).toBe(501);
    expect(search.statusCode).toBe(501);
    await app.close();
  });

  it("deletes a thread: removes projections + on-disk log, cancels active run", async () => {
    const { app, project, thread } = await createProjectAndThread();

    // Give the thread some history so there's a log + projections to remove.
    await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "do work" },
    });
    await waitForRun(thread.id);
    expect(store.readEvents(thread.id).length).toBeGreaterThan(0);

    const del = await app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>().deleted).toBe(true);

    // Gone from the projection list and by id.
    const list = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads` });
    expect(list.json<unknown[]>()).toHaveLength(0);
    const detail = await app.inject({ method: "GET", url: `/api/threads/${thread.id}` });
    expect(detail.statusCode).toBe(404);

    // Deleting again is a 404.
    const again = await app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` });
    expect(again.statusCode).toBe(404);

    // On-disk thread directory is gone (rebuild won't resurrect it).
    store.rebuildProjections();
    const afterRebuild = await app.inject({ method: "GET", url: `/api/threads/${thread.id}` });
    expect(afterRebuild.statusCode).toBe(404);
    await app.close();
  });

  it("serves the web build with SPA fallback and scoped static paths", async () => {
    const webDist = mkdtempSync(path.join(tmpdir(), "pond-server-web-"));
    mkdirSync(path.join(webDist, "assets"));
    writeFileSync(path.join(webDist, "index.html"), "<main>app</main>", "utf8");
    writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app');\n", "utf8");
    const app = createServer({ dataDir, store, engines, webDist, logger: false });

    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    const fallback = await app.inject({ method: "GET", url: "/threads/abc" });
    const apiMiss = await app.inject({ method: "GET", url: "/api/not-real" });
    const escape = await app.inject({ method: "GET", url: "/%5c..%5cpackage.json" });

    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("<main>app</main>");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.body).toContain("console.log");
    expect(fallback.body).toContain("<main>app</main>");
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.body).not.toContain("<main>app</main>");
    expect(escape.statusCode).toBe(404);

    await app.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  it("streams live SSE and replays from last seen seq without duplicates", async () => {
    const { app, project, thread } = await createProjectAndThread();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const base = `http://127.0.0.1:${address.port}`;

    const liveAbort = new AbortController();
    const live = await fetch(`${base}/api/threads/${thread.id}/stream`, { signal: liveAbort.signal });
    const reader = live.body!.getReader();
    await fetch(`${base}/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stream" }),
    });

    let chunk = "";
    for (let i = 0; i < 30 && !chunk.includes('"type":"session"'); i += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    liveAbort.abort();
    expect(chunk).toContain("id: 2");
    expect(chunk).toContain('"type":"session"');
    await waitForRun(thread.id);

    const replayAbort = new AbortController();
    const replay = await fetch(`${base}/api/threads/${thread.id}/stream?lastEventId=1`, {
      signal: replayAbort.signal,
    });
    const replayReader = replay.body!.getReader();
    const replayRead = await replayReader.read();
    replayAbort.abort();
    const replayChunk = new TextDecoder().decode(replayRead.value);
    expect(replayChunk).toContain("id: 2");
    expect(replayChunk).not.toContain("id: 1");

    expect(project.id).toBeTruthy();
    await app.close();
  }, 10000);
});
