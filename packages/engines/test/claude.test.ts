import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { ClaudeAdapter } from "../src/claude.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeClaude = join(here, "fake-claude.mjs");
const cwd = here; // a real, existing dir — spawn requires it

function fakeAdapter(mode: string): ClaudeAdapter {
  const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
    spawn(process.execPath, [fakeClaude, mode], opts)) as unknown as typeof spawn;
  return new ClaudeAdapter({ spawnFn, killGraceMs: 50 });
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("ClaudeAdapter surface", () => {
  it("exposes id, displayName, models, efforts", () => {
    const a = new ClaudeAdapter();
    expect(a.id).toBe("claude");
    expect(a.displayName).toBe("Claude");
    expect(a.listModels().some((m) => m.id === "opus")).toBe(true);
    expect(a.listEfforts().map((e) => e.id)).toContain("high");
  });
});

describe("ClaudeAdapter.seed (fake claude)", () => {
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
    expect(events[0]).toEqual({ type: "session", sessionId: "claude-sess-1" });
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "text",
      "command",
      "tool_result",
      "text",
      "turn_done",
    ]);
    const cmd = events.find((e) => e.type === "command");
    expect(cmd).toEqual({ type: "command", command: "echo hi", cwd });
  });

  it("emits an error on nonzero exit", async () => {
    const controller = new AbortController();
    const events = await collect(
      fakeAdapter("fail").seed({
        threadId: "t1",
        cwd,
        prompt: "x",
        history: [],
        signal: controller.signal,
      }),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message: string }).message).toContain("claude exited with code 1");
    expect((events.at(-1) as { message: string }).message).toContain("not authenticated");
  });

  it("aborting mid-run kills the process and ends the stream", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const ev of fakeAdapter("hang").seed({
      threadId: "t1",
      cwd,
      prompt: "x",
      history: [],
      signal: controller.signal,
    })) {
      events.push(ev);
      if (ev.type === "session") controller.abort();
    }
    expect(events[0]).toEqual({ type: "session", sessionId: "claude-sess-hang" });
    expect(events.at(-1)).toEqual({ type: "error", message: "run cancelled" });
  });
});

describe("ClaudeAdapter.continue", () => {
  it("passes --resume with the session id", () => {
    let captured: readonly string[] = [];
    const spawnFn = ((_bin: string, args: readonly string[], opts: object) => {
      captured = args;
      return spawn(process.execPath, [fakeClaude, "seed"], opts);
    }) as unknown as typeof spawn;
    const adapter = new ClaudeAdapter({ spawnFn, killGraceMs: 50 });
    const controller = new AbortController();
    // start the stream (don't need to consume) to trigger spawn synchronously
    void adapter.continue({
      threadId: "t1",
      cwd,
      prompt: "next",
      resumeSessionId: "sess-xyz",
      signal: controller.signal,
    })[Symbol.asyncIterator]().next();
    expect(captured).toContain("--resume");
    expect(captured).toContain("sess-xyz");
    expect(captured).toContain("stream-json");
    controller.abort();
  });
});
