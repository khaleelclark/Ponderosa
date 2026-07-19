import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { CodexAdapter, readCodexModels, renderSeedPrompt } from "../src/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodex = join(here, "fake-codex.mjs");
// A real, existing cwd — spawn() requires the working dir to exist.
const cwd = here;

/** Build an adapter whose "codex" is our fake, running in a given mode. */
function fakeAdapter(mode: string): CodexAdapter {
  const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
    spawn(process.execPath, [fakeCodex, mode], opts)) as unknown as typeof spawn;
  return new CodexAdapter({ spawnFn, killGraceMs: 50 });
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("renderSeedPrompt", () => {
  it("returns the bare prompt when history is empty (v1 first-message case)", () => {
    expect(renderSeedPrompt([], "do the thing")).toBe("do the thing");
  });
  it("renders prior turns as a minimal transcript before the current request", () => {
    const out = renderSeedPrompt(
      [
        { role: "user", text: "first" },
        { role: "assistant", text: "ok" },
      ],
      "second",
    );
    expect(out).toContain("User: first");
    expect(out).toContain("Assistant: ok");
    expect(out).toContain("Current request:\nsecond");
  });
  it("renders generated artifacts as revalidated result references without publishing a managed path", () => {
    const out = renderSeedPrompt([{
      role: "assistant",
      text: "Pinned result",
      attachments: [{
        name: "result.txt",
        mediaType: "text/plain",
        size: 12,
        available: false,
        artifactId: "artifact-closed-reference",
        retrievalUrl: "ponderosa://artifact/artifact-closed-reference",
      }],
    }], "inspect it");
    expect(out).toContain("artifactId=artifact-closed-reference");
    expect(out).toContain("retrieval=ponderosa://artifact/artifact-closed-reference");
    expect(out).not.toContain("managedPath");
    expect(out).not.toContain("/projects/");

    const uploaded = renderSeedPrompt([{
      role: "user",
      text: "Uploaded evidence",
      attachments: [{
        name: "evidence.pdf",
        mediaType: "application/pdf",
        size: 8,
        localPath: "/validated/attachment.pdf",
        available: true,
      }],
    }], "inspect it");
    expect(uploaded).toContain("/validated/attachment.pdf");
  });
});

describe("CodexAdapter.seed (fake codex)", () => {
  it("halts after JSON decode while the live child and all stdio remain connected", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observed: import("../src/process.js").ProcessStreamSnapshot | undefined;
    let decoded = 0;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fakeCodex, "live_stream"], opts)) as unknown as typeof spawn;
    const adapter = new CodexAdapter({ spawnFn, killGraceMs: 50, processFaults: {
      keepStdinOpen: true,
      afterDecodeBeforeYield: async (_raw, snapshot) => {
        decoded += 1;
        if (decoded === 2) { observed = snapshot; await gate; }
      },
    } });
    const events: AgentEvent[] = [];
    const consuming = (async () => {
      for await (const event of adapter.seed({ agentId: "t-live", cwd, prompt: "live", history: [], signal: controller.signal })) events.push(event);
    })();
    await vi.waitFor(() => expect(observed).toBeDefined());
    expect(observed).toMatchObject({ parentPid: process.pid, exitCode: null, stdinOpen: true, stdoutOpen: true, stderrOpen: true });
    expect(observed?.pid).toBeTypeOf("number");
    expect(events).toEqual([{ type: "session", sessionId: "sess-live" }]);
    controller.abort();
    release();
    await consuming;
  });

  it("streams mapped AgentEvents and captures the session id", async () => {
    const controller = new AbortController();
    const events = await collect(
      fakeAdapter("seed").seed({
        agentId: "t1",
        cwd,
        prompt: "hello",
        history: [],
        signal: controller.signal,
      }),
    );
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-123" });
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "session",
      "command",
      "tool_result",
      "text",
      "turn_done",
    ]);
    const cmd = events.find((e) => e.type === "command");
    expect(cmd).toEqual({ type: "command", command: "echo hi", cwd });
  });

  it("emits an error and exits when the process fails (nonzero exit)", async () => {
    const controller = new AbortController();
    const events = await collect(
      fakeAdapter("fail").seed({
        agentId: "t1",
        cwd,
        prompt: "hello",
        history: [],
        signal: controller.signal,
      }),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message: string }).message).toContain("code 1");
    expect((events.at(-1) as { message: string }).message).toContain("not logged in");
  });

  it("aborting mid-run kills the process and ends the stream", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const stream = fakeAdapter("hang").seed({
      agentId: "t1",
      cwd,
      prompt: "hello",
      history: [],
      signal: controller.signal,
    });
    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === "session") controller.abort(); // cancel as soon as it starts
    }
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-hang" });
    expect(events.at(-1)).toEqual({ type: "error", message: "run cancelled" });
  });

  it("yields an error if aborted before the run starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      fakeAdapter("seed").seed({
        agentId: "t1",
        cwd,
        prompt: "hello",
        history: [],
        signal: controller.signal,
      }),
    );
    expect(events).toEqual([{ type: "error", message: "run aborted before start" }]);
  });
});

describe("CodexAdapter.continue transport", () => {
  it("uses codex exec resume with the stored session id and reads the next prompt from stdin", async () => {
    const calls: Array<{ bin: string; args: readonly string[]; cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = ((bin: string, args: readonly string[], opts: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv }) => {
      calls.push({ bin, args, cwd: opts.cwd, detached: opts.detached, env: opts.env });
      return spawn(process.execPath, [fakeCodex, "seed"], opts);
    }) as unknown as typeof spawn;

    const controller = new AbortController();
    const adapter = new CodexAdapter({ bin: "codex-test", spawnFn, killGraceMs: 50 });
    await collect(
      adapter.continue({
        agentId: "t1",
        cwd,
        prompt: "second turn only",
        resumeSessionId: "sess-abc",
        model: "gpt-test",
        effort: "high",
        environment: { PONDEROSA_AGENT_MESSAGE_TOKEN: "scoped-token" },
        signal: controller.signal,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe("codex-test");
    expect(calls[0]?.cwd).toBe(cwd);
    expect(calls[0]?.detached).toBe(process.platform !== "win32");
    expect(calls[0]?.env?.PONDEROSA_AGENT_MESSAGE_TOKEN).toBe("scoped-token");
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "exec",
      "resume",
      "sess-abc",
      "--json",
    ]);
    expect(calls[0]?.args).toContain("--skip-git-repo-check");
    expect(calls[0]?.args).toContain("-m");
    expect(calls[0]?.args).toContain("gpt-test");
    expect(calls[0]?.args).toContain("model_reasoning_effort=\"high\"");
    expect(calls[0]?.args.at(-1)).toBe("-");
    expect(calls[0]?.args).not.toContain("second turn only");
  });

  it("streams prompts larger than the OS argv limit through stdin", async () => {
    const prompt = "x".repeat(3 * 1024 * 1024);
    const controller = new AbortController();
    const events = await collect(
      fakeAdapter("stdin").continue({
        agentId: "t1",
        cwd,
        prompt,
        resumeSessionId: "sess-large",
        signal: controller.signal,
      }),
    );

    expect(events).toContainEqual({
      type: "text",
      delta: `stdin-bytes:${Buffer.byteLength(prompt)}`,
    });
    expect(events.at(-1)?.type).toBe("turn_done");
  });

  it("lets the authenticated CLI choose its defaults when overrides are omitted", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const spawnFn = ((_bin: string, args: readonly string[], opts: object) => {
      calls.push({ args });
      return spawn(process.execPath, [fakeCodex, "seed"], opts);
    }) as unknown as typeof spawn;

    const controller = new AbortController();
    const adapter = new CodexAdapter({ spawnFn, killGraceMs: 50 });
    await collect(
      adapter.seed({
        agentId: "t1",
        cwd,
        prompt: "use account defaults",
        history: [],
        signal: controller.signal,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).not.toContain("-m");
    expect(calls[0]?.args.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
  });
});

describe("CodexAdapter surface", () => {
  it("exposes id, displayName, models, and efforts", () => {
    const a = new CodexAdapter({ modelsCachePath: join(cwd, "missing-models-cache.json") });
    expect(a.id).toBe("codex");
    expect(a.displayName).toBe("Codex");
    expect(a.listModels()).toEqual([{ id: "", label: "Codex default" }]);
    expect(a.listEfforts().map((e) => e.id)).toContain("high");
  });

  it("lists the models exposed by the authenticated Codex CLI cache", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ponderosa-codex-models-"));
    const cachePath = join(tempDir, "models-cache.json");
    writeFileSync(cachePath, JSON.stringify({
      models: [
        {
          slug: "gpt-new", display_name: "GPT New", visibility: "list", default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "xhigh" }],
        },
        { slug: "gpt-hidden", display_name: "Internal", visibility: "hide" },
        { slug: "gpt-new", display_name: "Duplicate", visibility: "list" },
        { slug: "gpt-fallback-label", visibility: "list" },
      ],
    }));

    expect(readCodexModels(cachePath)).toEqual([
      { id: "", label: "Codex default" },
      {
        id: "gpt-new", label: "GPT New", defaultEffort: "medium",
        efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "xhigh", label: "Extra high" }],
      },
      { id: "gpt-fallback-label", label: "gpt-fallback-label" },
    ]);
    rmSync(tempDir, { recursive: true });
  });

  it("uses the authenticated model cache for model-specific efforts", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ponderosa-codex-efforts-"));
    const cachePath = join(tempDir, "models-cache.json");
    writeFileSync(cachePath, JSON.stringify({ models: [
      { slug: "luna", display_name: "Luna", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
      { slug: "sol", display_name: "Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }] },
    ] }));
    const adapter = new CodexAdapter({ modelsCachePath: cachePath });

    expect(adapter.listEfforts("luna").map((option) => option.id)).toEqual(["low", "high"]);
    expect(adapter.listEfforts("sol").map((option) => option.id)).toEqual(["low", "max", "ultra"]);
    expect(adapter.listEfforts().map((option) => option.id)).toEqual(["low"]);
    expect(adapter.listEfforts("luna").map((option) => option.id)).not.toContain("minimal");
    rmSync(tempDir, { recursive: true });
  });

  it("preserves an explicitly empty provider effort roster", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ponderosa-codex-empty-efforts-"));
    const cachePath = join(tempDir, "models-cache.json");
    writeFileSync(cachePath, JSON.stringify({ models: [
      { slug: "fixed", display_name: "Fixed", visibility: "list", supported_reasoning_levels: [] },
    ] }));
    const adapter = new CodexAdapter({ modelsCachePath: cachePath });
    expect(adapter.listModels()).toContainEqual(expect.objectContaining({ id: "fixed", efforts: [] }));
    expect(adapter.listEfforts("fixed")).toEqual([]);
    expect(adapter.listEfforts()).toEqual([]);
    rmSync(tempDir, { recursive: true });
  });

  it("falls back to the Codex default for an invalid model cache", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ponderosa-codex-models-"));
    const cachePath = join(tempDir, "models-cache.json");
    writeFileSync(cachePath, "not json");
    expect(readCodexModels(cachePath)).toEqual([{ id: "", label: "Codex default" }]);
    rmSync(tempDir, { recursive: true });
  });
});
