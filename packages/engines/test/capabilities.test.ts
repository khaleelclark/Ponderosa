import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composerCapabilities, discoverEnginePlugins, discoverMarkdownCommands, normalizeCodexProviderDiscovery, parseClaudeMcpList, parseCodexMcpList } from "../src/capabilities.js";

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
      { path: commands, source: "built-in" },
    ])).toEqual([
      { name: "review", description: "Review the current change", source: "skill", acceptsArguments: true, insertText: "/review ", status: "available", invocation: "prompt" },
      { name: "ship", description: "Ship the current branch", source: "built-in", acceptsArguments: true, insertText: "/ship ", status: "available", invocation: "prompt" },
    ]);
  });

  it("normalizes inherited MCP status from both subscription CLIs", () => {
    expect(parseCodexMcpList("No MCP servers configured yet.")).toEqual([]);
    expect(parseClaudeMcpList([
      "claude.ai Expedia: https://example.test/mcp - ✔ Connected",
      "claude.ai Broken: https://broken.test/sse - ✘ Failed to connect",
    ].join("\n"))).toEqual([
      { name: "Expedia", configured: true, initialization: "initialized", usable: true, toolsDiscovered: false, toolCount: 0, health: "unknown", detail: "Connected" },
      { name: "Broken", configured: true, initialization: "failed", usable: false, toolsDiscovered: false, toolCount: 0, health: "unknown", detail: "Failed to connect" },
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
      [
        { name: "gmail", configured: true, initialization: "initialized", usable: true, toolsDiscovered: false, toolCount: 0, health: "unknown", detail: "Connected" },
        { name: "offline", configured: true, initialization: "failed", usable: false, toolsDiscovered: false, toolCount: 0, health: "unknown" },
      ],
      "$",
    );
    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "skill:github:review-pr", kind: "skill", insertText: "$github:review-pr " }),
      expect.objectContaining({ id: "plugin:github", kind: "plugin" }),
      expect.objectContaining({ id: "connector:gmail", kind: "connector", status: "available" }),
    ]));
    expect(capabilities.some((capability) => capability.id === "connector:offline")).toBe(false);
  });

  it("uses Codex app-server discovery for user skills, installed plugins, and model-gated structured actions", () => {
    const available = normalizeCodexProviderDiscovery({
      cwd: "/repo",
      selectedModel: "model-a",
      sessionId: "thread-a",
      skills: { data: [{ cwd: "/repo", errors: [], skills: [
        { name: "user-added-audit", description: "Audit the current change", enabled: true, scope: "user" },
      ] }] },
      plugins: { marketplaces: [{ name: "local", plugins: [{ name: "acme", installed: true, enabled: true, availability: "AVAILABLE", interface: { displayName: "Acme", shortDescription: "Acme tools" } }] }] },
      pluginDetails: [{ plugin: {
        summary: { name: "acme", installed: true, enabled: true },
        skills: [{ name: "release", description: "Release through Acme", enabled: true }],
      } }],
      models: { data: [{ id: "model-a", hidden: false, isDefault: true }] },
      configuredMcps: [],
    });
    expect(available.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "user-added-audit", source: "skill", insertText: "$user-added-audit " }),
      expect.objectContaining({ name: "acme:release", source: "plugin", pluginName: "acme" }),
      expect.objectContaining({ name: "compact", source: "built-in", invocation: "runtime", status: "available" }),
    ]));

    const changedModel = normalizeCodexProviderDiscovery({
      cwd: "/repo", selectedModel: "model-b", sessionId: "thread-a",
      skills: { data: [] }, models: { data: [{ id: "model-a", hidden: false, isDefault: true }] }, configuredMcps: [],
    });
    expect(changedModel.commands.find((command) => command.name === "compact")).toMatchObject({
      status: "unavailable", unavailableReason: expect.stringContaining("model-b"),
    });
  });

  it("keeps configured, initialized, callable, failed, and health-unknown MCP facts distinct", () => {
    const configured = parseCodexMcpList(JSON.stringify([{
      name: "waiting", enabled: true,
      transport: { command: "sensitive-command", args: ["sensitive-arg"], env: { SECRET_NAME: "sensitive-value" }, cwd: "/private/path" },
    }]));
    expect(configured[0]).toMatchObject({ initialization: "not_initialized", toolsDiscovered: false, usable: false });
    expect(JSON.stringify(configured)).not.toMatch(/sensitive|SECRET_NAME|private\/path/);

    const catalog = normalizeCodexProviderDiscovery({
      cwd: "/repo",
      configuredMcps: [...configured, { name: "failed", configured: true, initialization: "not_initialized", usable: false, toolsDiscovered: false, toolCount: 0, health: "unknown" }],
      mcpStatuses: { data: [
        { name: "zero", tools: {}, authStatus: "unsupported" },
        { name: "callable", tools: { search: { name: "search" } }, authStatus: "unsupported" },
      ] },
      mcpStartup: new Map([["failed", { status: "failed", error: "handshake rejected" }]]),
      skills: { data: [] }, models: { data: [] },
    });
    expect(catalog.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "waiting", initialization: "not_initialized", usable: false, toolsDiscovered: false }),
      expect.objectContaining({ name: "zero", initialization: "initialized", usable: true, toolsDiscovered: true, toolCount: 0, health: "unknown" }),
      expect.objectContaining({ name: "callable", initialization: "initialized", usable: true, toolCount: 1, health: "unknown" }),
      expect.objectContaining({ name: "failed", initialization: "failed", usable: false, detail: "handshake rejected" }),
    ]));
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
