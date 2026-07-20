import { readFileSync } from "node:fs";
import type { AgentDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../src/agents";
import { agentStatusFilterOptions, STATUS_FILTERS } from "../src/components/AgentsTab";

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
    expect(source).toContain('labelId="agents-status-filter-label"');
    expect(source).toContain('aria-label": "Filter agents by status"');
    expect(source).not.toContain("ToggleButtonGroup");
  });
});
