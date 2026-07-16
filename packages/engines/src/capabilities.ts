import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { EngineCommand, EngineComposerCapability, EngineMcpServer } from "@ponderosa/core";

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
      status: "available",
      insertText: `${skillInvocationPrefix}${command.name}${command.acceptsArguments ? " " : ""}`,
    });
  }
  for (const plugin of plugins) capabilities.set(plugin.capability.id, plugin.capability);
  for (const server of mcpServers) {
    if (server.status === "disconnected") continue;
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
      });
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseCodexMcpList(output: string): EngineMcpServer[] {
  if (/No MCP servers configured/i.test(output)) return [];
  return output.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || /^Name\s+/i.test(trimmed) || /^-+$/.test(trimmed)) return [];
    const [name] = trimmed.split(/\s{2,}/);
    return name ? [{ name, status: "unknown" as const }] : [];
  });
}

export function parseClaudeMcpList(output: string): EngineMcpServer[] {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(?:claude\.ai\s+)?([^:]+):\s+(.+?)\s+-\s+([✔✘])\s*(.*)$/u);
    if (!match) return [];
    return [{
      name: match[1]!.trim(),
      status: match[3] === "✔" ? "connected" as const : "disconnected" as const,
      ...(match[4]?.trim() ? { detail: match[4].trim() } : {}),
    }];
  });
}

export async function discoverCliMcps(
  bin: string,
  args: string[],
  cwd: string,
  parse: (output: string) => EngineMcpServer[],
): Promise<EngineMcpServer[]> {
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
