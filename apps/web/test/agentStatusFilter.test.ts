import { readFileSync } from "node:fs";
import type { AgentDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../src/agents";
import {
  agentHasCollapsedAncestor,
  agentHierarchyContextIds,
  agentStatusFilterOptions,
  matchesAgentStatusFilters,
  STATUS_FILTERS,
} from "../src/components/AgentsTab";

const source = readFileSync(new URL("../src/components/AgentsTab.tsx", import.meta.url), "utf8");

function agent(id: string, assigned = true): AgentDto {
  return {
    id,
    projectId: "project-1",
    title: `Agent ${id}`,
    conversationIds: assigned ? ["chat-1"] : [],
    activeEngine: "codex",
    state: {},
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    archived: false,
  };
}

describe("agent status filter", () => {
  it("keeps every canonical status in one compact counted control", () => {
    const agents = [agent("running"), agent("waiting"), agent("idle", false), agent("failed")];
    const statuses = new Map<string, AgentStatus>([
      ["running", "running"],
      ["waiting", "waiting"],
      ["failed", "failed"],
    ]);
    const options = agentStatusFilterOptions(agents, statuses);

    expect(options[0]).toEqual({ value: "all", label: "All", count: 4 });
    expect(options.find((option) => option.value === "running")?.count).toBe(1);
    expect(options.find((option) => option.value === "idle")?.count).toBe(1);
    expect(options.find((option) => option.value === "unassigned")?.count).toBe(1);
    expect(options.map((option) => option.value)).toEqual([
      "all", ...STATUS_FILTERS.map((option) => option.value), "unassigned",
    ]);
    expect(source).toContain('aria-label="Filter Agents by status"');
    expect(source).toContain("statusAnchor");
    expect(source).not.toContain("ToggleButtonGroup");
  });

  it("matches any selected status while keeping an empty selection equivalent to all", () => {
    expect(matchesAgentStatusFilters(agent("one"), "running", [])).toBe(true);
    expect(matchesAgentStatusFilters(agent("one"), "running", ["running", "waiting"])).toBe(true);
    expect(matchesAgentStatusFilters(agent("one"), "blocked", ["running", "waiting"])).toBe(false);
    expect(matchesAgentStatusFilters(agent("one", false), "idle", ["unassigned", "running"])).toBe(true);
  });

  it("keeps matching descendants' ancestors as context and hides descendants of collapsed rows", () => {
    const root = agent("root");
    const child = { ...agent("child"), managerAgentId: root.id };
    const leaf = { ...agent("leaf"), managerAgentId: child.id };
    const agents = [root, child, leaf];
    expect(agentHierarchyContextIds(agents, new Set([leaf.id]))).toEqual(new Set([root.id, child.id, leaf.id]));
    const byId = new Map(agents.map((item) => [item.id, item]));
    expect(agentHasCollapsedAncestor(leaf, byId, new Set([root.id]))).toBe(true);
    expect(agentHasCollapsedAncestor(leaf, byId, new Set())).toBe(false);
  });

  it("exposes hierarchy, flat, collapse, and orphan affordances", () => {
    expect(source).toContain('aria-label="Show Agent hierarchy"');
    expect(source).toContain('aria-label="Show flat Agent list"');
    expect(source).toContain('"Unlinked Agent"');
    expect(source).toContain('`${expanded ? "Collapse" : "Expand"} ${agent.title}`');
  });
});
