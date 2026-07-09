import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { CodexAdapter, renderSeedPrompt } from "../src/codex.js";

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

describe("CodexAdapter surface", () => {
  it("exposes id, displayName, models, and efforts", () => {
    const a = new CodexAdapter();
    expect(a.id).toBe("codex");
    expect(a.displayName).toBe("Codex");
    expect(a.listModels().length).toBeGreaterThan(0);
    expect(a.listEfforts().map((e) => e.id)).toContain("high");
  });
});
