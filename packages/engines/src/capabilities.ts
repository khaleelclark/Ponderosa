import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { EngineCapabilities, EngineCapabilityDiscoveryOptions, EngineCommand, EngineComposerCapability, EngineMcpServer } from "@ponderosa/core";
import { runtimeProcessHandle } from "./process-termination.js";

const execFile = promisify(nodeExecFile);

function frontmatterValue(markdown: string, key: string): string | undefined {
  const match = markdown.match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "m"));
  return match?.[1]?.trim();
}

function markdownSummary(markdown: string): string {
  const description = frontmatterValue(markdown, "description");
  if (description) return description;
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, "")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean) ?? "Engine-provided command";
}

function commandName(file: string, markdown: string): string {
  return (frontmatterValue(markdown, "name") ?? path.basename(file, path.extname(file)))
    .trim()
    .replace(/^\/+/, "");
}

function walkMarkdown(root: string, predicate: (file: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && predicate(file)) files.push(file);
    }
  };
  visit(root);
  return files;
}

interface PluginManifest {
  name?: unknown;
  description?: unknown;
  skills?: unknown;
  interface?: {
    displayName?: unknown;
    shortDescription?: unknown;
  };
}

/**
 * Resolve a plugin-declared resource without allowing it to escape the
 * installed plugin version. The lexical check rejects absolute/traversal
 * paths; the realpath check also fences symlink escapes.
 */
function resolvePluginResource(versionRoot: string, declaredPath: string): string | undefined {
  if (path.isAbsolute(declaredPath) || declaredPath.split(/[\\/]+/u).includes("..")) return undefined;
  const normalizedRoot = path.resolve(versionRoot);
  const candidate = path.resolve(normalizedRoot, path.normalize(declaredPath));
  const lexicalRelative = path.relative(normalizedRoot, candidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) return undefined;
  // A plugin may declare an optional resource that is not installed. Its
  // normalized location is still contained and discovery will simply find no
  // commands there.
  if (!existsSync(candidate)) return candidate;
  try {
    const realRoot = realpathSync(normalizedRoot);
    const realCandidate = realpathSync(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return undefined;
    return realCandidate;
  } catch {
    return undefined;
  }
}

export interface DiscoveredEnginePlugin {
  capability: EngineComposerCapability;
  commands: EngineCommand[];
}

/**
 * Discover only plugin manifests that the runtime can currently load. Remote
 * Codex cache entries require their installation marker; project/local plugin
 * roots may opt out because their presence is the installation itself.
 */
export function discoverEnginePlugins(
  roots: Array<{ path: string; requireInstallMarker: boolean }>,
): DiscoveredEnginePlugin[] {
  const plugins = new Map<string, DiscoveredEnginePlugin>();
  for (const root of roots) {
    const manifests = walkMarkdown(root.path, (candidate) => path.basename(candidate) === "plugin.json")
      .sort((a, b) => b.localeCompare(a));
    for (const manifestFile of manifests) {
      const pluginRoot = path.dirname(path.dirname(path.dirname(manifestFile)));
      if (root.requireInstallMarker && !existsSync(path.join(pluginRoot, ".codex-remote-plugin-install.json"))) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as PluginManifest;
        if (typeof manifest.name !== "string" || !manifest.name.trim()) continue;
        const name = manifest.name.trim();
        if (plugins.has(name)) continue;
        const label = typeof manifest.interface?.displayName === "string" && manifest.interface.displayName.trim()
          ? manifest.interface.displayName.trim()
          : name;
        const description = typeof manifest.interface?.shortDescription === "string" && manifest.interface.shortDescription.trim()
          ? manifest.interface.shortDescription.trim()
          : typeof manifest.description === "string" && manifest.description.trim()
            ? manifest.description.trim()
            : "Runtime plugin";
        const versionRoot = path.dirname(path.dirname(manifestFile));
        const declaredSkillsPath = typeof manifest.skills === "string" && manifest.skills.trim()
          ? manifest.skills.trim()
          : "skills";
        const skillsPath = resolvePluginResource(versionRoot, declaredSkillsPath);
        if (!skillsPath) continue;
        plugins.set(name, {
          capability: {
            id: `plugin:${name}`,
            kind: "plugin",
            label,
            description,
            status: "available",
          },
          commands: discoverMarkdownCommands([{ path: skillsPath, source: "plugin", skillFilesOnly: true }]).map((command) => ({
            ...command,
            name: `${name}:${command.name}`,
            insertText: `$${name}:${command.name} `,
            pluginName: name,
          })),
        });
      } catch {
        // A malformed plugin manifest is not currently available to the runtime.
      }
    }
  }
  return [...plugins.values()].sort((a, b) => a.capability.label.localeCompare(b.capability.label));
}

export function composerCapabilities(
  commands: EngineCommand[],
  plugins: DiscoveredEnginePlugin[],
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

export function discoverMarkdownCommands(
  roots: Array<{ path: string; source: EngineCommand["source"]; skillFilesOnly?: boolean }>,
): EngineCommand[] {
  const commands = new Map<string, EngineCommand>();
  for (const root of roots) {
    for (const file of walkMarkdown(root.path, (candidate) =>
      root.skillFilesOnly ? path.basename(candidate) === "SKILL.md" : candidate.endsWith(".md"))) {
      const markdown = readFileSync(file, "utf8");
      const name = commandName(file, markdown);
      if (!name || commands.has(name)) continue;
      commands.set(name, {
        name,
        description: markdownSummary(markdown),
        source: root.source,
        acceptsArguments: true,
        insertText: `/${name} `,
        status: "available",
        invocation: "prompt",
      });
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseCodexMcpList(output: string): EngineMcpServer[] {
  if (/No MCP servers configured/i.test(output)) return [];
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      if (typeof raw.name !== "string" || !raw.name.trim()) return [];
      const enabled = raw.enabled !== false;
      return [{
        name: raw.name.trim(),
        configured: true,
        initialization: "not_initialized" as const,
        usable: false,
        toolsDiscovered: false,
        toolCount: 0,
        health: "unknown" as const,
        ...(!enabled ? { detail: typeof raw.disabled_reason === "string" && raw.disabled_reason.trim()
          ? raw.disabled_reason.trim() : "Disabled in the provider configuration" } : {}),
      }];
    });
  } catch {
    // Older harnesses expose only the human-readable table.
  }
  return output.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^Name\s+/i.test(trimmed) || /^-+$/.test(trimmed)) return [];
    const [name] = trimmed.split(/\s{2,}/);
    return name ? [{
      name,
      configured: true,
      initialization: "not_initialized" as const,
      usable: false,
      toolsDiscovered: false,
      toolCount: 0,
      health: "unknown" as const,
    }] : [];
  });
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

export interface CodexProviderDiscovery {
  cwd: string;
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

/** Normalize only provider-owned app-server responses. No docs/TUI command
 * catalog is copied into Ponderosa. Structured actions are limited to Codex
 * operations that the app-server can execute without terminal UI state. */
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
    const id = string(model?.id) ?? string(model?.model);
    return id && model?.hidden !== true ? [{ id, isDefault: model?.isDefault === true }] : [];
  });
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
    source: "built-in",
    acceptsArguments: false,
    insertText: "/compact",
    status: compactUnavailable ? "unavailable" : "available",
    ...(compactUnavailable ? { unavailableReason: compactUnavailable } : {}),
    invocation: "runtime",
  });
  commands.set("status", {
    name: "status",
    description: "Show Codex session configuration, context usage, and subscription limits",
    source: "built-in",
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
  const plugins: DiscoveredEnginePlugin[] = [...installedPlugins].map(([name, meta]) => ({
    capability: { id: `plugin:${name}`, kind: "plugin", label: meta.label, description: meta.description, status: "available" },
    commands: [],
  }));
  const commandList = [...commands.values()];
  return {
    steering: true,
    persistentSessions: true,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
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
    const source: EngineCommand["source"] = declaredSource === "plugin" || pluginName
      ? "plugin" : declaredSource === "skill" || skillNames.has(name) ? "skill" : "built-in";
    commands.set(name, {
      name,
      description: string(advertised?.description) ?? "Claude-advertised command",
      source,
      acceptsArguments: advertised?.accepts_arguments !== false,
      insertText: `/${name}${advertised?.accepts_arguments === false ? "" : " "}`,
      status: "available",
      invocation: "prompt",
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
  spawnFn: typeof nodeSpawn = nodeSpawn,
): Promise<EngineMcpServer[]> {
  if (lifecycle) {
    if (lifecycle.signal.aborted) return parse("");
    const child = spawnFn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const handle = runtimeProcessHandle(child, { label: `${bin} capability discovery`, termGraceMs: killGraceMs });
    lifecycle.onRuntimeSpawned(handle);
    let output = "";
    const append = (chunk: Buffer | string): void => {
      output = (output + String(chunk)).slice(-(1024 * 1024));
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
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
    const timeout = setTimeout(abort, 15_000);
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
    return parse(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    const output = error && typeof error === "object"
      ? `${"stdout" in error ? String(error.stdout ?? "") : ""}\n${"stderr" in error ? String(error.stderr ?? "") : ""}`
      : "";
    return parse(output);
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
