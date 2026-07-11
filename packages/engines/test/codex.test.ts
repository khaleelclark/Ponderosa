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
});

describe("CodexAdapter.seed (fake codex)", () => {
  it("streams mapped AgentEvents and captures the session id", async () => {
    const controller = new AbortController();
    const events = await collect(
      fakeAdapter("seed").seed({
        threadId: "t1",
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
        threadId: "t1",
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
      threadId: "t1",
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
        threadId: "t1",
        cwd,
        prompt: "hello",
        history: [],
        signal: controller.signal,
      }),
    );
    expect(events).toEqual([{ type: "error", message: "run aborted before start" }]);
  });
});

describe("CodexAdapter.continue argv", () => {
  it("uses codex exec resume with the stored session id and next prompt only", async () => {
    const calls: Array<{ bin: string; args: readonly string[]; cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = ((bin: string, args: readonly string[], opts: { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv }) => {
      calls.push({ bin, args, cwd: opts.cwd, detached: opts.detached, env: opts.env });
      return spawn(process.execPath, [fakeCodex, "seed"], opts);
    }) as unknown as typeof spawn;

    const controller = new AbortController();
    const adapter = new CodexAdapter({ bin: "codex-test", spawnFn, killGraceMs: 50 });
    await collect(
      adapter.continue({
        threadId: "t1",
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
    expect(calls[0]?.args.at(-1)).toBe("second turn only");
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
        threadId: "t1",
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
        { slug: "gpt-new", display_name: "GPT New", visibility: "list" },
        { slug: "gpt-hidden", display_name: "Internal", visibility: "hide" },
        { slug: "gpt-new", display_name: "Duplicate", visibility: "list" },
        { slug: "gpt-fallback-label", visibility: "list" },
      ],
    }));

    expect(readCodexModels(cachePath)).toEqual([
      { id: "", label: "Codex default" },
      { id: "gpt-new", label: "GPT New" },
      { id: "gpt-fallback-label", label: "gpt-fallback-label" },
    ]);
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

describe("CodexAdapter launch authorization", () => {
  it("rejects a delegated run before spawning codex", async () => {
    const spawnFn = vi.fn() as unknown as typeof spawn;
    const adapter = new CodexAdapter({ spawnFn });

    const rejection = Object.assign(new Error("proof rejected"), {
      code: "registration_mismatch",
    });

    const consume = async () => {
      for await (const _event of adapter.seed({
        threadId: "delegated",
        cwd,
        prompt: "work",
        history: [],
        signal: new AbortController().signal,
        authorizeLaunch: async () => {
          throw rejection;
        },
      })) {
        // Authorization rejects before the provider can emit an event.
      }
    };

    await expect(consume()).rejects.toBe(rejection);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
