import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentStore } from "./store.js";

const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("scheduler Agent engine assignments", () => {
  test("reads every live Agent without hydrating presentation metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-agent-engines-"));
    directories.push(root);
    const hostPath = join(root, "workspace");
    mkdirSync(hostPath, { recursive: true });
    const store = new AgentStore(join(root, "data"));
    stores.push(store);
    const firstProject = store.createProject({
      label: "First",
      hostPath,
      defaultEngine: "codex",
    });
    const secondProject = store.createProject({
      label: "Second",
      hostPath,
      defaultEngine: "claude",
    });
    const codex = store.createAgent(firstProject.id, {
      title: "Codex Agent",
      engine: "codex",
      conversationId: firstProject.lastConversationId,
    });
    const claude = store.createAgent(secondProject.id, {
      title: "Claude Agent",
      engine: "claude",
      conversationId: secondProject.lastConversationId,
    });

    expect(store.listAgentEngineAssignments()).toEqual([
      { id: claude.id, activeEngine: "claude" },
      { id: codex.id, activeEngine: "codex" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
