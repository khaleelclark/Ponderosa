import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, RuntimeProcessHandle } from "@ponderosa/core";
import { CodexAppServerSession, discoverCodexAppServerCapabilities, mapCodexAppServerNotification, mapCodexTokenUsage, reconcileProviderRequestUsage, subtractUsage, sumProviderRequestUsage } from "../src/codex-app-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fake-codex-app-server.mjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retainOpeningHandleForTest = (_handle: RuntimeProcessHandle): void => undefined;
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const codexThreadSettings = (model: string) => ({
  cwd: here,
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "dangerFullAccess" },
  activePermissionProfile: null,
  model,
  modelProvider: "openai",
  serviceTier: null,
  effort: null,
  summary: null,
  collaborationMode: {
    mode: "default",
    settings: { model, reasoning_effort: null, developer_instructions: null },
  },
  multiAgentMode: "explicitRequestOnly",
  personality: null,
});

describe("Codex app-server persistent runtime", () => {
  it("bounds sessionless capability discovery and terminates an unresponsive app-server", async () => {
    let child: ChildProcess | undefined;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => {
      child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], opts);
      return child;
    }) as unknown as typeof spawn;

    const capabilities = await discoverCodexAppServerCapabilities({
      bin: "codex",
      spawnFn,
      cwd: here,
      sandboxMode: "workspace-write",
      killGraceMs: 25,
      timeoutMs: 25,
      signal: new AbortController().signal,
      onRuntimeSpawned: retainOpeningHandleForTest,
      configuredMcps: [{
        name: "configured",
        configured: true,
        initialization: "not_initialized",
        usable: false,
        toolsDiscovered: false,
        toolCount: 0,
        health: "unknown",
      }],
    });

    expect(capabilities.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "configured", configured: true }),
    ]));
    expect(child).toBeDefined();
    await vi.waitFor(() => expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true));
  });

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
  it("maps the complete current Codex usage breakdown without inventing cache writes", () => {
    const usage = mapCodexTokenUsage({
      totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2,
    });
    expect(usage).toEqual({ totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 });
    // Codex 0.144.1's generated app-server TokenUsageBreakdown has no
    // cache-write field. Ponderosa must not derive one from the other totals.
    expect(usage).not.toHaveProperty("cacheWriteInputTokens");
  });
  it("derives one execution from compatible absolute thread checkpoints and rejects resets", () => {
    expect(subtractUsage(
      { totalTokens: 999, inputTokens: 800, cachedInputTokens: 400, cacheWriteInputTokens: 50, outputTokens: 199, reasoningOutputTokens: 100 },
      { totalTokens: 981, inputTokens: 785, cachedInputTokens: 396, cacheWriteInputTokens: 48, outputTokens: 196, reasoningOutputTokens: 98 },
    )).toEqual({ totalTokens: 18, inputTokens: 15, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 2 });
    expect(subtractUsage(
      { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      { totalTokens: 20, inputTokens: 16, outputTokens: 4 },
    )).toBeUndefined();
  });
  it("keeps request detail only when it reconciles to the turn aggregate", () => {
    const requests = [
      { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 1, outputTokens: 2 },
      { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 6 },
    ];
    expect(reconcileProviderRequestUsage(
      { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, cacheWriteInputTokens: 3, outputTokens: 8 },
      requests,
    )).toEqual(requests);
    expect(reconcileProviderRequestUsage(
      { totalTokens: 26, inputTokens: 18, cachedInputTokens: 4, cacheWriteInputTokens: 3, outputTokens: 8 },
      requests,
    )).toBeUndefined();
  });
  it("derives an exact aggregate from complete per-request checkpoints", () => {
    expect(sumProviderRequestUsage([
      { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 },
      { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 6, reasoningOutputTokens: 2 },
    ])).toEqual({ totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, cacheWriteInputTokens: 3, outputTokens: 8, reasoningOutputTokens: 2 });
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
    const draining = (async () => { for await (const _event of session.events) { /* drain provider notifications */ } })();
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
    await draining;
  });

  it("single-flights discovery and retries an invalidated in-flight generation", async () => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "single-flight", cwd: here, history: [], resumeSessionId: "codex-thread-v1",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        threadModel: "model-b",
        skillsDelayMs: 40,
        modelResponses: [
          { data: [{ id: "model-a", hidden: false, isDefault: true }], nextCursor: null },
          { data: [
            { id: "model-a", hidden: false, isDefault: true },
            { id: "model-b", hidden: false, isDefault: false },
          ], nextCursor: null },
        ],
        notificationsAfterMcpDiscoveryOnce: true,
        notificationsAfterMcpDiscovery: [{ method: "skills/changed", params: {} }],
      }) },
    });
    const draining = (async () => { for await (const _event of session.events) { /* drain provider notifications */ } })();
    const [first, concurrent] = await Promise.all([session.capabilities(), session.capabilities()]);
    expect(concurrent).toBe(first);
    expect(first).toMatchObject({ model: "model-b", catalogVersion: "codex-thread-v1:1" });
    expect(first.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    expect(changes).toHaveLength(1);
    expect(await session.capabilities()).toBe(first);
    await session.close();
    await draining;
  });

  it("uses the provider-accepted model when resuming a thread", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "resume-model", cwd: here, history: [], resumeSessionId: "codex-thread-v1",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        threadModel: "model-b",
        models: { data: [
          { id: "model-a", hidden: false, isDefault: true },
          { id: "model-b", hidden: false, isDefault: false },
        ], nextCursor: null },
      }) },
    });
    const capabilities = await session.capabilities();
    expect(capabilities.model).toBe("model-b");
    expect(capabilities.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    await session.close();
  });

  it.each([
    ["fresh", undefined],
    ["resumed", "codex-thread-v1"],
  ])("keeps the accepted/default model when a %s session turn has no override", async (_label, resumeSessionId) => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "default-model", cwd: here, history: [], resumeSessionId,
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        threadModel: "model-a",
        rejectTurnStartModel: "model-b",
        models: { data: [
          { id: "model-a", hidden: false, isDefault: true },
          { id: "model-b", hidden: false, isDefault: false },
        ], nextCursor: null },
      }) },
    });
    const before = await session.capabilities();
    expect(before.model).toBe("model-a");
    await expect(session.startTurn({ prompt: "keep the session model", kind: "user_message" }))
      .resolves.toEqual({ turnId: "turn-1" });
    expect(await session.capabilities()).toBe(before);
    expect(changes).toHaveLength(0);
    await session.close();
  });

  it("updates the live catalog only after an A-to-B turn override is accepted", async () => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "override-model", cwd: here, history: [], model: "model-a",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        models: { data: [
          { id: "model-a", hidden: false, isDefault: true },
        ], nextCursor: null },
      }) },
    });
    const before = await session.capabilities();
    expect(before.model).toBe("model-a");
    await session.startTurn({ prompt: "use model B", kind: "user_message", model: "model-b" });
    const after = await session.capabilities();
    expect(after).toMatchObject({ model: "model-b", catalogVersion: "codex-thread-v1:1" });
    expect(after.commands.find((command) => command.name === "compact")).toMatchObject({
      status: "unavailable", unavailableReason: "The selected model (model-b) is not currently available.",
    });
    expect(changes).toHaveLength(1);
    await session.close();
  });

  it("retains the active model when a turn override is rejected", async () => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "rejected-model", cwd: here, history: [], model: "model-a",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        rejectTurnStartModel: "model-b",
        models: { data: [{ id: "model-a", hidden: false, isDefault: true }], nextCursor: null },
      }) },
    });
    const before = await session.capabilities();
    await expect(session.startTurn({ prompt: "reject model B", kind: "user_message", model: "model-b" }))
      .rejects.toThrow("model model-b was rejected");
    expect(await session.capabilities()).toBe(before);
    expect(before.model).toBe("model-a");
    expect(changes).toHaveLength(0);
    await session.close();
  });

  it.each([
    ["model/rerouted", {
      method: "model/rerouted",
      params: {
        threadId: "codex-thread-v1", turnId: "turn-1", fromModel: "model-b", toModel: "model-a",
        reason: "highRiskCyberActivity",
      },
    }],
    ["thread/settings/updated", {
      method: "thread/settings/updated",
      params: { threadId: "codex-thread-v1", threadSettings: codexThreadSettings("model-a") },
    }],
  ])("keeps authoritative %s state when it arrives before turn/start completes", async (_method, notification) => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "model-notification-before-response", cwd: here, history: [], model: "model-a",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        models: { data: [{ id: "model-a", hidden: false, isDefault: true }], nextCursor: null },
        notificationsBeforeTurnStartResponse: [notification],
      }) },
    });
    const draining = (async () => { for await (const _event of session.events) { /* drain provider notifications */ } })();
    await session.startTurn({ prompt: "request model B", kind: "user_message", model: "model-b" });
    const capabilities = await session.capabilities();
    expect(capabilities).toMatchObject({ model: "model-a", catalogVersion: "codex-thread-v1:1" });
    expect(capabilities.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    expect(changes).toHaveLength(1);
    await session.close();
    await draining;
  });

  it.each([
    ["model/rerouted", {
      method: "model/rerouted",
      params: {
        threadId: "codex-thread-v1", turnId: "turn-1", fromModel: "model-b", toModel: "model-a",
        reason: "highRiskCyberActivity",
      },
    }],
    ["thread/settings/updated", {
      method: "thread/settings/updated",
      params: { threadId: "codex-thread-v1", threadSettings: codexThreadSettings("model-a") },
    }],
  ])("applies authoritative %s state once when it arrives after turn/start", async (_method, notification) => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "model-notification-after-response", cwd: here, history: [], model: "model-a",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        models: { data: [{ id: "model-a", hidden: false, isDefault: true }], nextCursor: null },
        notificationsAfterTurnStartResponse: [notification],
      }) },
    });
    const draining = (async () => { for await (const _event of session.events) { /* drain provider notifications */ } })();
    await session.startTurn({ prompt: "request model B", kind: "user_message", model: "model-b" });
    expect(changes).toHaveLength(1);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    const capabilities = await session.capabilities();
    expect(capabilities).toMatchObject({ model: "model-a", catalogVersion: "codex-thread-v1:2" });
    expect(capabilities.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    await session.close();
    await draining;
  });

  it.each([
    ["an unknown reroute reason", {
      method: "model/rerouted",
      params: {
        threadId: "codex-thread-v1", turnId: "turn-1", fromModel: "model-b", toModel: "model-a",
        reason: "loadBalancing",
      },
    }],
    ["partial thread settings", {
      method: "thread/settings/updated",
      params: { threadId: "codex-thread-v1", threadSettings: { model: "model-a" } },
    }],
    ["invalid complete thread settings", {
      method: "thread/settings/updated",
      params: {
        threadId: "codex-thread-v1",
        threadSettings: { ...codexThreadSettings("model-a"), approvalPolicy: "sometimes" },
      },
    }],
    ["omitted multi-agent mode", {
      method: "thread/settings/updated",
      params: {
        threadId: "codex-thread-v1",
        threadSettings: { ...codexThreadSettings("model-a"), multiAgentMode: undefined },
      },
    }],
    ["an unknown multi-agent mode", {
      method: "thread/settings/updated",
      params: {
        threadId: "codex-thread-v1",
        threadSettings: { ...codexThreadSettings("model-a"), multiAgentMode: "automatic" },
      },
    }],
    ["a blank custom multi-agent mode", {
      method: "thread/settings/updated",
      params: {
        threadId: "codex-thread-v1",
        threadSettings: { ...codexThreadSettings("model-a"), multiAgentMode: { custom: "  " } },
      },
    }],
    ["a non-exact custom multi-agent mode", {
      method: "thread/settings/updated",
      params: {
        threadId: "codex-thread-v1",
        threadSettings: {
          ...codexThreadSettings("model-a"),
          multiAgentMode: { custom: "delegate narrowly", unexpected: true },
        },
      },
    }],
  ])("ignores same-thread provider state with %s", async (_label, notification) => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "schema-invalid-model-notification", cwd: here, history: [], model: "model-b",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        models: { data: [{ id: "model-b", hidden: false, isDefault: true }], nextCursor: null },
        notificationsBeforeTurnStartResponse: [notification],
      }) },
    });
    const draining = (async () => { for await (const _event of session.events) { /* drain provider notifications */ } })();
    const before = await session.capabilities();
    expect(before).toMatchObject({ model: "model-b", catalogVersion: "codex-thread-v1:0" });
    expect(before.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    await session.startTurn({ prompt: "keep the active model", kind: "user_message" });
    const after = await session.capabilities();
    expect(after).toBe(before);
    expect(after).toMatchObject({ model: "model-b", catalogVersion: "codex-thread-v1:0" });
    expect(after.commands.find((command) => command.name === "compact")).toMatchObject({ status: "available" });
    expect(changes).toHaveLength(0);
    await session.close();
    await draining;
  });

  it("ignores foreign-thread and malformed provider model notifications", async () => {
    const controller = new AbortController();
    const changes: number[] = [];
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "invalid-model-notification", cwd: here, history: [], model: "model-a",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onCapabilitiesChanged: () => changes.push(Date.now()),
      environment: { PONDEROSA_TEST_CODEX_CATALOG: JSON.stringify({
        models: { data: [{ id: "model-a", hidden: false, isDefault: true }], nextCursor: null },
        notificationsBeforeTurnStartResponse: [
          {
            method: "model/rerouted",
            params: { threadId: "foreign-thread", turnId: "turn-1", fromModel: "model-b", toModel: "foreign", reason: "highRiskCyberActivity" },
          },
          { method: "model/rerouted", params: { threadId: "codex-thread-v1", toModel: "malformed" } },
          { method: "thread/settings/updated", params: { threadId: "foreign-thread", threadSettings: { model: "foreign" } } },
          { method: "thread/settings/updated", params: { threadId: "codex-thread-v1", threadSettings: { model: "  " } } },
        ],
      }) },
    });
    const draining = (async () => { for await (const _event of session.events) { /* drain provider notifications */ } })();
    await session.startTurn({ prompt: "request model B", kind: "user_message", model: "model-b" });
    expect(await session.capabilities()).toMatchObject({ model: "model-b", catalogVersion: "codex-thread-v1:1" });
    expect(changes).toHaveLength(1);
    await session.close();
    await draining;
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

  it("treats a planned rollover/replacement close as expected and waits for observed SIGKILL exit", async () => {
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
    const plannedClose = session.close();
    expect(session.close()).toBe(plannedClose);
    let settled = false;
    void plannedClose.then(() => { settled = true; }, () => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    expect(processAlive(pid)).toBe(true);
    await plannedClose;
    expect(processAlive(pid)).toBe(false);
    expect(rootExitCount).toBe(0);
  });

  it("reports an independently exiting persistent root exactly once", async () => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    let rootExitCount = 0;
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => {
      child = spawn(process.execPath, [fake], opts);
      return child;
    }) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "crashing-codex", cwd: here, history: [], signal: controller.signal,
      bin: "codex", spawnFn, sandboxMode: "danger-full-access", killGraceMs: 50,
      onRuntimeSpawned: retainOpeningHandleForTest,
      onRuntimeRootExit: () => { rootExitCount += 1; },
    });

    child!.kill("SIGKILL");
    await vi.waitFor(() => expect(rootExitCount).toBe(1));
    expect(session.isAlive()).toBe(false);
    await session.close();
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
