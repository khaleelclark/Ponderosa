import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { EngineCommand, EngineMcpServer } from "@ponderosa/core";

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
