import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composerCapabilities, discoverEnginePlugins, discoverMarkdownCommands, parseClaudeMcpList, parseCodexMcpList } from "../src/capabilities.js";

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

  it("discovers installed plugin manifests and normalizes composer actions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pond-plugins-"));
    roots.push(root);
    const plugin = path.join(root, "remote", "github");
    const version = path.join(plugin, "1.0.0");
    const skill = path.join(version, "skills", "review");
    mkdirSync(path.join(version, ".codex-plugin"), { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(plugin, ".codex-remote-plugin-install.json"), "{}");
    writeFileSync(path.join(version, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "github",
      description: "GitHub tools",
      skills: "./skills",
      interface: { displayName: "GitHub", shortDescription: "Review repositories" },
    }));
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review-pr\ndescription: Review a pull request\n---\n");

    const plugins = discoverEnginePlugins([{ path: root, requireInstallMarker: true }]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.capability).toMatchObject({ id: "plugin:github", kind: "plugin", label: "GitHub" });
    const capabilities = composerCapabilities(
      plugins.flatMap((item) => item.commands),
      plugins,
      [{ name: "gmail", status: "connected", detail: "Connected" }, { name: "offline", status: "disconnected" }],
      "$",
    );
    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "skill:github:review-pr", kind: "skill", insertText: "$github:review-pr " }),
      expect.objectContaining({ id: "plugin:github", kind: "plugin" }),
      expect.objectContaining({ id: "connector:gmail", kind: "connector", status: "available" }),
    ]));
    expect(capabilities.some((capability) => capability.id === "connector:offline")).toBe(false);
  });

  it.each([
    ["an absolute skills root", (version: string, outside: string) => outside],
    ["a traversing skills root", () => "../outside"],
  ])("rejects plugin manifests with %s", (_label, declaredSkills) => {
    const root = mkdtempSync(path.join(tmpdir(), "pond-plugin-containment-"));
    roots.push(root);
    const plugin = path.join(root, "remote", "unsafe");
    const version = path.join(plugin, "1.0.0");
    const outside = path.join(root, "outside");
    mkdirSync(path.join(version, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(outside, "escaped"), { recursive: true });
    writeFileSync(path.join(plugin, ".codex-remote-plugin-install.json"), "{}");
    writeFileSync(path.join(outside, "escaped", "SKILL.md"), "---\nname: escaped\n---\n");
    writeFileSync(path.join(version, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "unsafe",
      skills: declaredSkills(version, outside),
    }));

    expect(discoverEnginePlugins([{ path: root, requireInstallMarker: true }])).toEqual([]);
  });

  it("rejects a plugin skills symlink that escapes its version root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pond-plugin-symlink-"));
    roots.push(root);
    const plugin = path.join(root, "remote", "unsafe-link");
    const version = path.join(plugin, "1.0.0");
    const outside = path.join(root, "outside-skills");
    mkdirSync(path.join(version, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(outside, "escaped"), { recursive: true });
    symlinkSync(outside, path.join(version, "skills"), "dir");
    writeFileSync(path.join(plugin, ".codex-remote-plugin-install.json"), "{}");
    writeFileSync(path.join(outside, "escaped", "SKILL.md"), "---\nname: escaped\n---\n");
    writeFileSync(path.join(version, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "unsafe-link", skills: "./skills" }));

    expect(discoverEnginePlugins([{ path: root, requireInstallMarker: true }])).toEqual([]);
  });
});
