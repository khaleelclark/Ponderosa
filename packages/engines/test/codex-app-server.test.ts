import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent, RuntimeProcessHandle } from "@ponderosa/core";
import { CodexAppServerSession, mapCodexAppServerNotification, mapCodexTokenUsage, reconcileProviderRequestUsage, subtractUsage, sumProviderRequestUsage } from "../src/codex-app-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fake-codex-app-server.mjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retainOpeningHandleForTest = (_handle: RuntimeProcessHandle): void => undefined;
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

describe("Codex app-server persistent runtime", () => {
  it("injects canonical history into the first turn of a fresh persistent session", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "history", cwd: here, history: [{ role: "assistant", text: "History marker" }],
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
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
  it("normalizes the per-turn usage breakdown without double-counting cached tokens", () => {
    expect(mapCodexTokenUsage({ totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 }))
      .toEqual({ totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 });
  });
  it("derives one execution from compatible absolute thread checkpoints and rejects resets", () => {
    expect(subtractUsage(
      { totalTokens: 999, inputTokens: 800, cachedInputTokens: 400, outputTokens: 199, reasoningOutputTokens: 100 },
      { totalTokens: 981, inputTokens: 785, cachedInputTokens: 396, outputTokens: 196, reasoningOutputTokens: 98 },
    )).toEqual({ totalTokens: 18, inputTokens: 15, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 2 });
    expect(subtractUsage(
      { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      { totalTokens: 20, inputTokens: 16, outputTokens: 4 },
    )).toBeUndefined();
  });
  it("keeps request detail only when it reconciles to the turn aggregate", () => {
    const requests = [
      { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
      { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6 },
    ];
    expect(reconcileProviderRequestUsage(
      { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8 },
      requests,
    )).toEqual(requests);
    expect(reconcileProviderRequestUsage(
      { totalTokens: 26, inputTokens: 18, cachedInputTokens: 4, outputTokens: 8 },
      requests,
    )).toBeUndefined();
  });
  it("derives an exact aggregate from complete per-request checkpoints", () => {
    expect(sumProviderRequestUsage([
      { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 },
    ])).toEqual({ totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 });
    expect(sumProviderRequestUsage([{ totalTokens: 7, inputTokens: 5 }])).toBeUndefined();
  });
  it("separates completed response blocks in Work log output", () => {
    const completed = (id: string, text: string) => mapCodexAppServerNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { id, type: "agentMessage", text } },
    } as never, "/repo");

    const text = [...completed("one", "Acadia."), ...completed("two", "The review is complete.")]
      .flatMap((event) => event.type === "text" ? [event.delta] : [])
      .join("");
    expect(text).toBe("Acadia.\n\nThe review is complete.\n\n");
  });

  it("starts one persistent thread and steers its active turn without spawning another", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "ponderosa-thread",
      cwd: here,
      history: [],
      signal: controller.signal,
      onRuntimeSpawned: retainOpeningHandleForTest,
      bin: "codex",
      spawnFn,
      sandboxMode: "danger-full-access",
      killGraceMs: 50,
    });
    expect(session.engineAgentId).toBe("codex-thread-v1");
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "initial work", kind: "user_message" });
    expect(await session.steer({ prompt: "new direction", kind: "user_message" }))
      .toEqual({ status: "accepted", turnId: "turn-1" });
    await collecting;
    expect(events).toEqual([
      { type: "session", sessionId: "codex-thread-v1" },
      { type: "text", delta: "steered response\n\n" },
      { type: "command", command: "git status", cwd: "/repo" },
      { type: "tool_result", id: "c1", output: "clean" },
      {
        type: "turn_done",
        usage: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 },
        providerRequestUsage: [
          { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
          { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 },
        ],
      },
    ]);
    await session.close();
  });

  it("invalidates an MCP catalog when provider startup status changes", async () => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "mcp-refresh", cwd: here, history: [], signal: controller.signal,
      bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      configuredMcps: [{
        name: "refreshing", configured: true, initialization: "not_initialized", usable: false,
        toolsDiscovered: false, toolCount: 0, health: "unknown",
      }],
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        mcpStatuses: { data: [], nextCursor: null },
        notificationsAfterMcpDiscovery: [{
          method: "mcpServer/startupStatus/updated",
          params: { name: "refreshing", status: "failed", error: "provider handshake failed" },
        }],
      }) },
    });
    const first = await session.capabilities();
    expect(first.mcpServers[0]).toMatchObject({ initialization: "not_initialized", usable: false });
    for (let attempt = 0; attempt < 20 && changes.length === 0; attempt += 1) await sleep(10);
    expect(changes).toHaveLength(1);
    const refreshed = await session.capabilities();
    expect(refreshed.catalogVersion).not.toBe(first.catalogVersion);
    expect(refreshed.mcpServers[0]).toMatchObject({
      initialization: "failed", usable: false, health: "unknown", detail: "provider handshake failed",
    });
    await session.close();
  });

  it("reads installed remote plugin skills by the provider-owned plugin id", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "plugin-discovery", cwd: here, history: [], signal: controller.signal,
      bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        plugins: { marketplaces: [{ name: "remote", path: null, plugins: [{
          name: "acme", remotePluginId: "remote-acme", installed: true, enabled: true, availability: "AVAILABLE",
        }] }] },
        pluginDetails: { "remote-acme": { plugin: {
          summary: { name: "acme", installed: true, enabled: true },
          skills: [{ name: "release", description: "Release through Acme", enabled: true }],
        } } },
      }) },
    });
    expect((await session.capabilities()).commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "acme:release", source: "plugin", pluginName: "acme", insertText: "$acme:release " }),
    ]));
    await session.close();
  });

  it("exhausts provider model and MCP status pagination", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "paginated-discovery", cwd: here, history: [], signal: controller.signal,
      model: "model-b", bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        modelPages: [
          { data: [{ id: "model-a", hidden: false, isDefault: true }] },
          { data: [{ id: "model-b", hidden: false, isDefault: false }] },
        ],
        mcpStatusPages: [
          { data: [{ name: "empty", tools: {}, authStatus: "unsupported" }] },
          { data: [{ name: "callable", tools: { search: { name: "search" } }, authStatus: "unsupported" }] },
        ],
      }) },
    });
    const capabilities = await session.capabilities();
    expect(capabilities.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    expect(capabilities.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "empty", toolsDiscovered: true, toolCount: 0, usable: true }),
      expect.objectContaining({ name: "callable", toolsDiscovered: true, toolCount: 1, usable: true }),
    ]));
    await session.close();
  });

  it("shares shutdown close and waits for observed SIGKILL exit when SIGTERM is ignored", async () => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    let rootExitCount = 0;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => {
      child = spawn(process.execPath, [fake], opts);
      return child;
    }) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "stubborn-codex", cwd: here, history: [], signal: controller.signal,
      bin: "codex", spawnFn, sandboxMode: "danger-full-access", killGraceMs: 80,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onRuntimeRootExit: () => { rootExitCount += 1; },
      environment: { PONDEROSA_TEST_IGNORE_SIGTERM: "1" },
    });
    const pid = child!.pid!;
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
    expect(rootExitCount).toBe(1);
  });

  it.each([
    ["initialize", { PONDEROSA_TEST_FAIL_INITIALIZE: "1" }],
    ["thread open", { PONDEROSA_TEST_FAIL_THREAD_OPEN: "1" }],
  ])("registers the provider process before a rejected %s handshake", async (_label, environment) => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    let openingHandle: RuntimeProcessHandle | undefined;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => {
      child = spawn(process.execPath, [fake], opts);
      return child;
    }) as unknown as typeof spawn;
    await expect(CodexAppServerSession.open({
      agentId: "failed-open", cwd: here, history: [], signal: controller.signal,
      bin: "codex", spawnFn, sandboxMode: "danger-full-access", killGraceMs: 50,
      environment,
      onRuntimeSpawned: (handle) => { openingHandle = handle; },
    })).rejects.toThrow(/simulated (initialize|thread open) failure/);
    expect(openingHandle).toBeDefined();
    expect(processAlive(child!.pid!)).toBe(true);
    await openingHandle!.close();
    expect(processAlive(child!.pid!)).toBe(false);
  });

  it("costs the first resumed turn from per-request checkpoints when no cumulative baseline is replayed", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "ponderosa-thread", cwd: here, history: [], resumeSessionId: "codex-thread-v1",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "danger-full-access", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
    });
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "resumed work", kind: "user_message" });
    await session.steer({ prompt: "finish resumed work", kind: "user_message" });
    await collecting;
    expect(events.at(-1)).toEqual({
      type: "turn_done",
      usage: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 },
      providerRequestUsage: [
        { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
        { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 },
      ],
    });
    await session.close();
  });

  it("executes host-owned dynamic tools without using the runtime shell", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const session = await CodexAppServerSession.open({
      agentId: "ponderosa-thread",
      cwd: here,
      history: [],
      signal: controller.signal,
      onRuntimeSpawned: retainOpeningHandleForTest,
      bin: "codex",
      spawnFn,
      sandboxMode: "workspace-write",
      killGraceMs: 50,
      dynamicTools: [{
        name: "ponderosa_message",
        description: "Send an explicitly scoped Ponderosa message.",
        inputSchema: { type: "object", required: ["intent", "text"] },
      }],
      handleDynamicToolCall: async (call) => {
        calls.push(call);
        return { success: true, text: JSON.stringify({ messageId: "message-1" }) };
      },
    });
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "send the result", kind: "user_message" });
    await collecting;
    expect(calls).toEqual([{
      name: "ponderosa_message",
      arguments: { intent: "broadcast", text: "Managed result" },
    }]);
    expect(events).toContainEqual({
      type: "tool_call",
      id: "tool-1",
      name: "ponderosa_message",
      input: { intent: "broadcast", text: "Managed result" },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "tool-1" }));
    expect(events).toContainEqual({ type: "text", delta: "Sent through Ponderosa.\n\n" });
    await session.close();
  });
});
