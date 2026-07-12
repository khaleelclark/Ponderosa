import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMarkdownCommands, parseClaudeMcpList, parseCodexMcpList } from "../src/capabilities.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engine capability discovery", () => {
  it("discovers skill and command markdown without coupling the web app to engine files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pond-capabilities-"));
    roots.push(root);
    const skill = path.join(root, "skills", "review");
    const commands = path.join(root, "commands");
    mkdirSync(skill, { recursive: true });
    mkdirSync(commands, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review\ndescription: Review the current change\n---\n");
    writeFileSync(path.join(commands, "ship.md"), "# Ship the current branch\n");

    expect(discoverMarkdownCommands([
      { path: path.join(root, "skills"), source: "skill", skillFilesOnly: true },
      { path: commands, source: "engine" },
    ])).toEqual([
      { name: "review", description: "Review the current change", source: "skill", acceptsArguments: true },
      { name: "ship", description: "Ship the current branch", source: "engine", acceptsArguments: true },
    ]);
  });

  it("normalizes inherited MCP status from both subscription CLIs", () => {
    expect(parseCodexMcpList("No MCP servers configured yet.")).toEqual([]);
    expect(parseClaudeMcpList([
      "claude.ai Expedia: https://example.test/mcp - ✔ Connected",
      "claude.ai Broken: https://broken.test/sse - ✘ Failed to connect",
    ].join("\n"))).toEqual([
      { name: "Expedia", status: "connected", detail: "Connected" },
      { name: "Broken", status: "disconnected", detail: "Failed to connect" },
    ]);
  });
});
