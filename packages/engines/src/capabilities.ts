import { execFile as nodeExecFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { EngineCapabilities, EngineCapabilityDiscoveryOptions, EngineCommand, EngineComposerCapability, EngineMcpServer } from "@ponderosa/core";
import { spawnContainedCli } from "./contained-spawn.js";
import { runtimeProcessHandle } from "./process-termination.js";
import { runtimeEnvironment } from "./runtime-environment.js";

const execFile = promisify(nodeExecFile);

export function composerCapabilities(
  commands: EngineCommand[],
  plugins: ReadonlyArray<{ capability: EngineComposerCapability }>,
  mcpServers: EngineMcpServer[],
  skillInvocationPrefix: "/" | "$",
): EngineComposerCapability[] {
  const capabilities = new Map<string, EngineComposerCapability>();
  for (const command of commands) {
    if (command.source !== "skill" && command.source !== "plugin") continue;
    const id = `skill:${command.name}`;
    if (capabilities.has(id)) continue;
    capabilities.set(id, {
      id,
      kind: "skill",
      label: command.name,
      description: command.description,
      status: command.status,
      ...(command.status === "available" ? {
        insertText: command.insertText || `${skillInvocationPrefix}${command.name}${command.acceptsArguments ? " " : ""}`,
      } : {}),
      ...(command.unavailableReason ? { unavailableReason: command.unavailableReason } : {}),
    });
  }
  for (const plugin of plugins) capabilities.set(plugin.capability.id, plugin.capability);
  for (const server of mcpServers) {
    if (!server.usable && (server.toolCount ?? 0) === 0) continue;
    capabilities.set(`connector:${server.name}`, {
      id: `connector:${server.name}`,
      kind: "connector",
      label: server.name,
      description: server.detail ?? "Runtime connector",
      status: "available",
    });
  }
  const kindOrder: Record<EngineComposerCapability["kind"], number> = { skill: 0, plugin: 1, connector: 2 };
  return [...capabilities.values()].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.label.localeCompare(b.label));
}

function configuredMcp(name: string, disabledReason?: string): EngineMcpServer {
  return {
    name, configured: true, initialization: "not_initialized", usable: false,
    toolsDiscovered: false, toolCount: 0, health: "unknown",
    ...(disabledReason ? { detail: disabledReason } : {}),
  };
}

/** Undefined means invalid discovery, distinct from a valid empty inventory. */
function codexMcpInventory(output: string): EngineMcpServer[] | undefined {
  const text = output.trim();
  if (/^No MCP servers configured(?: yet)?(?:\.(?: Try `codex mcp add [^\r\n]+`\.)?)?$/iu.test(text)) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return undefined; }
    if (!Array.isArray(parsed)) return undefined;
    const servers: EngineMcpServer[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const raw = item as Record<string, unknown>;
      if (typeof raw.name !== "string" || !/^[A-Za-z0-9_.:@/-]+$/u.test(raw.name.trim()) ||
          (raw.enabled !== undefined && typeof raw.enabled !== "boolean")) return undefined;
      servers.push(configuredMcp(raw.name.trim(), raw.enabled === false
        ? typeof raw.disabled_reason === "string" && raw.disabled_reason.trim()
          ? raw.disabled_reason.trim() : "Disabled in the provider configuration"
        : undefined));
    }
    return servers;
  }
  // Legacy CLI tables have an explicit transport header. A free-form line,
  // including diagnostic prose, can never introduce a configured server.
  let columns: string[] | undefined;
  let columnStarts: number[] = [];
  const servers: EngineMcpServer[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const row = line.trim();
    if (!row) continue;
    const cells = row.split(/\s{2,}/u);
    if (cells[0] === "Name" && (
      /^Command\|Args\|Env(?:\|Cwd)?(?:\|Status\|Auth)?$/u.test(cells.slice(1).join("|")) ||
      /^Url\|Bearer Token Env Var(?:\|Status\|Auth)?$/u.test(cells.slice(1).join("|"))
    )) {
      columns = cells;
      let offset = 0;
      columnStarts = cells.map(column => {
        const start = row.indexOf(column, offset);
        offset = start + column.length;
        return start;
      });
      continue;
    }
    if (columns && /^-+(?:\s+-+)*$/u.test(row)) continue;
    if (!columns) return undefined;
    if (/^(?:error|warning|fatal):/iu.test(row)) return undefined;
    // Fixed-width tables can contain double spaces inside Args/Env values.
    // Prefer the header's boundaries, retaining compact legacy tables too.
    const aligned = columnStarts.map((start, index) => row.slice(start, columnStarts[index + 1]).trim());
    const valid = (values: string[]): boolean => values.length === columns!.length &&
      /^[A-Za-z0-9_.:@/-]+$/u.test(values[0]!) && values.every(Boolean) &&
      (columns!.indexOf("Status") < 0 ||
        /^(?:enabled|disabled(?:: .+)?)$/u.test(values[columns!.indexOf("Status")]!));
    const alignedBoundaries = columnStarts.slice(1).every(start =>
      row.slice(start - 2, start) === "  " && /\S/u.test(row[start] ?? ""));
    const values = alignedBoundaries && aligned[0] === cells[0] && valid(aligned) ? aligned : cells;
    if (!valid(values)) return undefined;
    const status = values[columns.indexOf("Status")];
    servers.push(configuredMcp(values[0]!, status?.startsWith("disabled")
      ? status.slice("disabled: ".length).trim() || "Disabled in the provider configuration"
      : undefined));
  }
  return columns ? servers : undefined;
}

export function parseCodexMcpList(output: string): EngineMcpServer[] {
  return codexMcpInventory(output) ?? [];
}

/** CLI discovery must report invalid output as failure, not an empty success. */
export function parseCodexMcpDiscovery(output: string): EngineMcpServer[] {
  const servers = codexMcpInventory(output);
  if (!servers) throw new Error("Codex MCP discovery returned an invalid inventory");
  return servers;
}

export function parseClaudeMcpList(output: string): EngineMcpServer[] {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(?:claude\.ai\s+)?([^:]+):\s+(.+?)\s+-\s+([✔✘])\s*(.*)$/u);
    if (!match) return [];
    return [{
      name: match[1]!.trim(),
      configured: true,
      initialization: match[3] === "✔" ? "initialized" as const : "failed" as const,
      usable: match[3] === "✔",
      toolsDiscovered: false,
      toolCount: 0,
      health: "unknown" as const,
      ...(match[4]?.trim() ? { detail: match[4].trim() } : {}),
    }];
  });
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Claude includes terminal-client controls in system/init.slash_commands even
// for stream-json sessions. Only project provider commands that produce useful
// headless output or perform a session action; advertised skills and plugin
// commands are retained separately below.
const CLAUDE_HEADLESS_BUILT_IN_COMMANDS = new Set([
  "compact",
  "context",
  "doctor",
  "insights",
  "mcp",
  "recap",
  "usage",
]);

export interface CodexProviderDiscovery {
  cwd: string;
  cliVersion?: string;
  selectedModel?: string;
  sessionId?: string;
  skills?: unknown;
  plugins?: unknown;
  pluginDetails?: unknown[];
  models?: unknown;
  modelProviderCapabilities?: unknown;
  mcpStatuses?: unknown;
  mcpStartup?: ReadonlyMap<string, { status: string; error?: string }>;
  configuredMcps?: EngineMcpServer[];
}

/** Normalize provider-owned app-server responses plus the adapter's explicit
 * structured actions. No docs/TUI command catalog is copied into Ponderosa.
 * Adapter actions are labeled separately from provider-advertised commands. */
export function normalizeCodexProviderDiscovery(input: CodexProviderDiscovery): EngineCapabilities {
  const installedPlugins = new Map<string, { label: string; description: string }>();
  for (const marketplace of array(record(input.plugins)?.marketplaces)) {
    for (const candidate of array(record(marketplace)?.plugins)) {
      const plugin = record(candidate);
      const name = string(plugin?.name);
      if (!name || plugin?.installed !== true || plugin?.enabled !== true || plugin?.availability === "DISABLED_BY_ADMIN") continue;
      const ui = record(plugin.interface);
      installedPlugins.set(name, {
        label: string(ui?.displayName) ?? name,
        description: string(ui?.shortDescription) ?? "Provider plugin",
      });
    }
  }

  const commands = new Map<string, EngineCommand>();
  for (const entry of array(record(input.skills)?.data)) {
    for (const candidate of array(record(entry)?.skills)) {
      const skill = record(candidate);
      const name = string(skill?.name);
      if (!name || skill?.enabled === false || commands.has(name)) continue;
      const pluginName = [...installedPlugins.keys()].find((plugin) => name.startsWith(`${plugin}:`));
      commands.set(name, {
        name,
        description: string(skill?.description) ?? string(skill?.shortDescription) ?? "Provider skill",
        source: pluginName ? "plugin" : "skill",
        acceptsArguments: true,
        insertText: `$${name} `,
        status: "available",
        invocation: "prompt",
        ...(pluginName ? { pluginName } : {}),
      });
    }
  }
  for (const response of input.pluginDetails ?? []) {
    const detail = record(record(response)?.plugin);
    const summary = record(detail?.summary);
    const pluginName = string(summary?.name);
    if (!pluginName || summary?.installed !== true || summary?.enabled !== true) continue;
    for (const candidate of array(detail?.skills)) {
      const skill = record(candidate);
      const shortName = string(skill?.name);
      if (!shortName || skill?.enabled === false) continue;
      const name = `${pluginName}:${shortName}`;
      if (commands.has(name)) continue;
      commands.set(name, {
        name,
        description: string(skill?.description) ?? string(skill?.shortDescription) ?? "Provider plugin skill",
        source: "plugin",
        acceptsArguments: true,
        insertText: `$${name} `,
        status: "available",
        invocation: "prompt",
        pluginName,
      });
    }
  }

  const models = array(record(input.models)?.data).flatMap((candidate) => {
    const model = record(candidate);
    const id = string(model?.model) ?? string(model?.id);
    return id && model?.hidden !== true ? [{ id, isDefault: model?.isDefault === true }] : [];
  });
  const catalog = new Map<string, import("@ponderosa/core").EngineModelOption>();
  const rawModels = record(input.models)?.data;
  const catalogKnown = Array.isArray(rawModels) && rawModels.every(row => {
    const model = record(row);
    return Boolean(model && (string(model.model) ?? string(model.id)));
  });
  if (catalogKnown) for (const row of rawModels as unknown[]) {
    const model = record(row)!;
    const id = string(model.model) ?? string(model.id)!;
    if (model.hidden === true || catalog.has(id)) continue;
    const efforts = array(model.supportedReasoningEfforts).flatMap(row => {
      const effort = string(record(row)?.reasoningEffort);
      return effort ? [{ id: effort, label: effort }] : [];
    });
    const serviceTiers = array(model.serviceTiers ?? model.additionalSpeedTiers).flatMap(row => {
      const tier = record(row), id = typeof row === "string" ? string(row) : string(tier?.id);
      return id ? [{ id, label: string(tier?.displayName) ?? string(tier?.name) ?? id,
        ...((id === "priority" || id === "fast")
          ? { description: `${string(tier?.description)?.replace(/[. ]+$/, "") ?? "Faster responses, increased usage"}. Purchased credits use 2× the Standard rate.` }
          : string(tier?.description) ? { description: string(tier?.description)! } : {}) }] : [];
    });
    catalog.set(id, { id, ...(model.isDefault === true ? { isDefault: true } : {}), label: string(model.displayName) ?? id, kind: "alias", source: "provider-probe",
      ...(string(model.description) ? { description: string(model.description)! } : {}),
      ...(Array.isArray(model.supportedReasoningEfforts) ? { efforts, supportedEffortLevels: efforts.map(e => e.id) } : {}),
      ...(efforts.some(e => e.id === model.defaultReasoningEffort) ? { defaultEffort: String(model.defaultReasoningEffort) } : {}),
      ...(serviceTiers.length ? { serviceTiers } : {}),
      ...(serviceTiers.some(t => t.id === model.defaultServiceTier) ? { defaultServiceTier: String(model.defaultServiceTier) } : {}),
    });
  }
  const selectedModel = input.selectedModel || models.find((model) => model.isDefault)?.id;
  const modelAvailable = Boolean(selectedModel && models.some((model) => model.id === selectedModel));
  const compactUnavailable = !input.sessionId
    ? "Requires an active Codex session."
    : models.length === 0
      ? "The provider model catalog is unavailable."
      : !modelAvailable
        ? `The selected model (${selectedModel ?? "unknown"}) is not currently available.`
        : undefined;
  commands.set("compact", {
    name: "compact",
    description: "Compact the active Codex thread",
    source: "adapter-implemented",
    acceptsArguments: false,
    insertText: "/compact",
    status: compactUnavailable ? "unavailable" : "available",
    ...(compactUnavailable ? { unavailableReason: compactUnavailable } : {}),
    invocation: "runtime",
  });
  commands.set("status", {
    name: "status",
    description: "Show Codex session configuration, context usage, and subscription limits",
    source: "adapter-implemented",
    acceptsArguments: false,
    insertText: "/status",
    status: "available",
    invocation: "runtime",
  });

  const mcpByName = new Map((input.configuredMcps ?? []).map((server) => [server.name, { ...server }]));
  for (const candidate of array(record(input.mcpStatuses)?.data)) {
    const status = record(candidate);
    const name = string(status?.name);
    if (!name) continue;
    const toolCount = Object.keys(record(status?.tools) ?? {}).length;
    mcpByName.set(name, {
      name,
      configured: true,
      initialization: "initialized",
      usable: true,
      toolsDiscovered: true,
      toolCount,
      health: "unknown",
    });
  }
  for (const [name, startup] of input.mcpStartup ?? []) {
    const current = mcpByName.get(name) ?? {
      name, configured: true, initialization: "not_initialized" as const, usable: false,
      toolsDiscovered: false, toolCount: 0, health: "unknown" as const,
    };
    if (startup.status === "failed" || startup.status === "cancelled") {
      mcpByName.set(name, { ...current, initialization: "failed", usable: false, ...(startup.error ? { detail: startup.error } : {}) });
    } else if (startup.status === "starting") {
      mcpByName.set(name, { ...current, initialization: "initializing", usable: false });
    } else if (startup.status === "ready") {
      mcpByName.set(name, { ...current, initialization: "initialized", usable: true });
    }
  }

  const mcpServers = [...mcpByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const plugins: Array<{ capability: EngineComposerCapability }> = [...installedPlugins].map(([name, meta]) => ({
    capability: { id: `plugin:${name}`, kind: "plugin", label: meta.label, description: meta.description, status: "available" },
  }));
  const commandList = [...commands.values()];
  return {
    steering: true,
    persistentSessions: true,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(catalogKnown ? { modelCatalog: { models: [...catalog.values()].sort((a, b) =>
      Number(models.some(m => m.id === b.id && m.isDefault)) - Number(models.some(m => m.id === a.id && m.isDefault))),
      cliVersion: input.cliVersion ?? "unknown", configurationKey: "live" } } : {}),
    commands: commandList,
    mcpServers,
    composerCapabilities: composerCapabilities(commandList, plugins, mcpServers, "$"),
  };
}

export function normalizeClaudeInitCapabilities(init: unknown, selectedModel?: string): EngineCapabilities | undefined {
  const raw = record(init);
  if (raw?.type !== "system" || raw.subtype !== "init") return undefined;
  const skillNames = new Set(array(raw.skills).flatMap((candidate) => {
    const name = typeof candidate === "string" ? string(candidate) : string(record(candidate)?.name);
    return name ? [name] : [];
  }));
  const pluginNames = new Set(array(raw.plugins).flatMap((candidate) => {
    const name = typeof candidate === "string" ? string(candidate) : string(record(candidate)?.name);
    return name ? [name] : [];
  }));
  const commands = new Map<string, EngineCommand>();
  for (const candidate of array(raw.slash_commands)) {
    const advertised = typeof candidate === "string" ? { name: string(candidate) } : record(candidate);
    const name = string(advertised?.name)?.replace(/^\/+/, "");
    if (!name || commands.has(name)) continue;
    const declaredSource = string(advertised?.source);
    const pluginName = string(advertised?.plugin_name) ?? [...pluginNames].find((plugin) => name.startsWith(`${plugin}:`));
    const advertisedSource: EngineCommand["source"] = declaredSource === "plugin" || pluginName
      ? "plugin" : declaredSource === "skill" || skillNames.has(name) ? "skill" : "provider-advertised";
    if (advertisedSource === "provider-advertised" && !CLAUDE_HEADLESS_BUILT_IN_COMMANDS.has(name)) continue;
    const adapterImplemented = name === "usage" && advertisedSource === "provider-advertised";
    commands.set(name, {
      name,
      description: adapterImplemented
        ? "Show Claude subscription usage"
        : string(advertised?.description) ?? "Claude-advertised command",
      source: adapterImplemented ? "adapter-implemented" : advertisedSource,
      acceptsArguments: adapterImplemented ? false : advertised?.accepts_arguments !== false,
      insertText: `/${name}${adapterImplemented || advertised?.accepts_arguments === false ? "" : " "}`,
      status: "available",
      invocation: adapterImplemented ? "runtime" : "prompt",
      ...(pluginName ? { pluginName } : {}),
    });
  }

  const toolNames = array(raw.tools).flatMap((candidate) => typeof candidate === "string"
    ? [candidate] : string(record(candidate)?.name) ? [string(record(candidate)?.name)!] : []);
  const mcpServers = array(raw.mcp_servers).flatMap((candidate) => {
    const server = record(candidate);
    const name = string(server?.name);
    if (!name) return [];
    const providerStatus = string(server?.status)?.toLowerCase();
    const normalizedToolPrefix = `mcp__${name.replace(/[^\p{L}\p{N}_-]/gu, "_")}__`;
    const toolCount = toolNames.filter((tool) => tool.startsWith(`mcp__${name}__`) || tool.startsWith(normalizedToolPrefix)).length;
    const failed = providerStatus === "failed" || providerStatus === "disconnected" || providerStatus === "error";
    const initialized = providerStatus === "connected" || providerStatus === "ready" || toolCount > 0;
    return [{
      name,
      configured: true,
      initialization: failed ? "failed" as const : initialized ? "initialized" as const : "not_initialized" as const,
      usable: !failed && initialized,
      toolsDiscovered: true,
      toolCount,
      health: server?.health === "healthy" ? "healthy" as const : server?.health === "unhealthy" ? "unhealthy" as const : "unknown" as const,
      ...(string(server?.error) ? { detail: string(server?.error)! } : {}),
    }];
  });
  const commandList = [...commands.values()];
  return {
    steering: true,
    persistentSessions: true,
    ...(string(raw.session_id) ? { sessionId: string(raw.session_id)! } : {}),
    ...(selectedModel ? { selectedModel } : {}),
    ...(string(raw.model) ?? selectedModel ? { model: string(raw.model) ?? selectedModel! } : {}),
    ...(string(raw.claude_code_version) ? { catalogVersion: string(raw.claude_code_version)! } : {}),
    commands: commandList,
    mcpServers,
    composerCapabilities: composerCapabilities(commandList, [], mcpServers, "/"),
  };
}

export async function discoverCliMcps(
  bin: string,
  args: string[],
  cwd: string,
  parse: (output: string) => EngineMcpServer[],
  lifecycle?: EngineCapabilityDiscoveryOptions,
  killGraceMs = 3_000,
): Promise<EngineMcpServer[]> {
  if (lifecycle) {
    if (lifecycle.signal.aborted) throw new Error("MCP discovery aborted");
    let spawned: ReturnType<typeof spawnContainedCli>;
    try {
      spawned = spawnContainedCli({
        bin, args, cwd, env: runtimeEnvironment(), stdin: "ignore",
      });
    } catch {
      throw new Error("MCP discovery failed to start");
    }
    const child = spawned.child;
    const handle = runtimeProcessHandle(
      child,
      { label: `${bin} capability discovery`, termGraceMs: killGraceMs },
      spawned.authority,
    );
    lifecycle.onRuntimeSpawned(handle);
    let output = "";
    let outputTooLarge = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    child.once("error", error => { spawnError = error; });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = output + String(chunk);
      outputTooLarge ||= Buffer.byteLength(text) > 1024 * 1024;
      output = text.slice(-(1024 * 1024));
    });
    // Diagnostics are not inventory data. Drain stderr without retaining or
    // echoing configuration/credential values from a failed CLI.
    child.stderr?.resume();
    const rootExit = waitForDiscoveryRoot(child);
    const transportClosed = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("close", finish);
      child.once("error", finish);
    });
    let stopOperation: Promise<void> | undefined;
    let settleStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      settleStop = resolve;
      rejectStop = reject;
    });
    // This observer is deliberately installed immediately. A timeout whose
    // termination attempt fails must reject discovery instead of waiting
    // forever for a still-live root to emit exit.
    void stopped.catch(() => undefined);
    const stop = (): Promise<void> => {
      if (stopOperation) return stopOperation;
      stopOperation = handle.close().then(settleStop, (error) => {
        rejectStop(error);
        throw error;
      });
      void stopOperation.catch(() => undefined);
      return stopOperation;
    };
    const abort = (): void => { void stop().catch(() => undefined); };
    lifecycle.signal.addEventListener("abort", abort);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort(); }, 15_000);
    timeout.unref();
    try {
      await Promise.race([rootExit, stopped]);
      await stop();
      // Root exit can precede delivery of already-buffered stdout/stderr, while
      // an out-of-group descendant can retain those descriptors indefinitely.
      // Give terminal output one bounded drain window before parsing it.
      await Promise.race([
        transportClosed,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
      if (lifecycle.signal.aborted) throw new Error("MCP discovery aborted");
      if (timedOut) throw new Error("MCP discovery timed out");
      if (spawnError || child.exitCode !== 0 || child.signalCode) {
        throw new Error(`MCP discovery failed (${spawnError?.code ?? child.signalCode ?? child.exitCode ?? "no exit status"})`);
      }
      if (outputTooLarge) throw new Error("MCP discovery inventory exceeded its size limit");
      return parse(output);
    } finally {
      clearTimeout(timeout);
      lifecycle.signal.removeEventListener("abort", abort);
      await handle.close();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
  try {
    const result = await execFile(bin, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
    return parse(result.stdout);
  } catch (error) {
    // Never reinterpret failed-process stdout/stderr as configured entries.
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code) : "invalid inventory";
    throw new Error(`MCP discovery failed (${code})`);
  }
}

function waitForDiscoveryRoot(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
}
