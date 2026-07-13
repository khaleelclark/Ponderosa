import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { ClaudeStreamSession } from "../src/claude-stream-session.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fake-claude-stream.mjs");

describe("Claude persistent stream-json runtime", () => {
  it("steers an active process through realtime JSON input", async () => {
    const controller = new AbortController();
    let spawns = 0;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => {
      spawns += 1;
      return spawn(process.execPath, [fake], opts);
    }) as unknown as typeof spawn;
    const session = new ClaudeStreamSession({
      agentId: "ponderosa-thread",
      cwd: here,
      history: [],
      signal: controller.signal,
      bin: "claude",
      spawnFn,
      permissionMode: "bypassPermissions",
      killGraceMs: 50,
    });
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "initial", kind: "user_message" });
    expect(await session.steer({ prompt: "new direction", kind: "collaboration" }))
      .toMatchObject({ status: "accepted" });
    await collecting;
    expect(spawns).toBe(1);
    expect(events).toEqual([
      { type: "session", sessionId: "claude-stream-v1" },
      { type: "text", delta: "steered claude response" },
      { type: "turn_done", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    ]);
    await session.close();
  });
});
