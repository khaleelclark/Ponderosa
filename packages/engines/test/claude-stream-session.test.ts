import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent, RuntimeProcessHandle } from "@ponderosa/core";
import { ClaudeStreamSession } from "../src/claude-stream-session.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fake-claude-stream.mjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retainOpeningHandleForTest = (_handle: RuntimeProcessHandle): void => undefined;
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

describe("Claude persistent stream-json runtime", () => {
  it("injects canonical history into the first turn of a fresh persistent session", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = new ClaudeStreamSession({
      agentId: "history", cwd: here, history: [{ role: "assistant", text: "History marker" }],
      signal: controller.signal, bin: "claude", spawnFn, permissionMode: "bypassPermissions", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
    });
    const text: string[] = [];
    const collecting = (async () => { for await (const event of session.events) {
      if (event.type === "text") text.push(event.delta);
      if (event.type === "turn_done") return;
    } })();
    await session.startTurn({ prompt: "Current work", kind: "user_message" });
    await collecting;
    expect(text.join("")).toContain("Conversation so far:\nAssistant: History marker\n\nCurrent request:\nCurrent work");
    await session.close();
  });
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
      onRuntimeSpawned: retainOpeningHandleForTest,
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

  it("shares shutdown close and waits for observed SIGKILL exit when SIGTERM is ignored", async () => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => {
      child = spawn(process.execPath, [fake], opts);
      return child;
    }) as unknown as typeof spawn;
    const session = new ClaudeStreamSession({
      agentId: "stubborn-claude", cwd: here, history: [], signal: controller.signal,
      bin: "claude", spawnFn, permissionMode: "bypassPermissions", killGraceMs: 80,
      onRuntimeSpawned: retainOpeningHandleForTest,
      environment: { PONDEROSA_TEST_IGNORE_SIGTERM: "1" },
    });
    const pid = child!.pid!;
    const iterator = session.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: "session" }, done: false });
    controller.abort();
    const shutdownClose = session.close();
    expect(session.close()).toBe(shutdownClose);
    let settled = false;
    void shutdownClose.then(() => { settled = true; }, () => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    expect(processAlive(pid)).toBe(true);
    await shutdownClose;
    expect(processAlive(pid)).toBe(false);
  });

  it("exposes Ponderosa messaging through a host-side stdio MCP server", async () => {
    const controller = new AbortController();
    let capturedArgs: readonly string[] = [];
    const spawnFn = ((_bin: string, args: readonly string[], opts: object) => {
      capturedArgs = args;
      return spawn(process.execPath, [fake], opts);
    }) as unknown as typeof spawn;
    const session = new ClaudeStreamSession({
      agentId: "ponderosa-thread",
      cwd: here,
      history: [],
      signal: controller.signal,
      onRuntimeSpawned: retainOpeningHandleForTest,
      bin: "claude",
      spawnFn,
      permissionMode: "bypassPermissions",
      killGraceMs: 50,
      environment: {
        PONDEROSA_AGENT_MESSAGE_URL: "http://127.0.0.1:8787/api/agent-messages",
        PONDEROSA_AGENT_MESSAGE_TOKEN: "run-token",
      },
      dynamicTools: [{ name: "ponderosa_message", description: "Send", inputSchema: {} }],
    });
    const flagIndex = capturedArgs.indexOf("--mcp-config");
    expect(flagIndex).toBeGreaterThan(-1);
    const config = JSON.parse(capturedArgs[flagIndex + 1]!) as {
      mcpServers: { ponderosa: { command: string; args: string[]; env?: Record<string, string> } };
    };
    expect(config.mcpServers.ponderosa.command).toBe(process.execPath);
    expect(config.mcpServers.ponderosa.args[0]).toMatch(/ponderosa-mcp\.js$/);
    expect(config.mcpServers.ponderosa.env).toBeUndefined();
    expect(capturedArgs.join(" ")).not.toContain("run-token");
    await session.close();
  });
});
