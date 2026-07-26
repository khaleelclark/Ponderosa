import type { AgentDetailDto, AgentDto, AgentHealthDto } from "@ponderosa/core";
import { agentRoleProfile } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentStatusLabel, deriveAgentStatus, mergeAgentStatuses, orderedAgentOrganization } from "../src/agents";

const organizationAgent = (id: string, title: string, parent?: string): AgentDto => ({
  id, title, projectId: "project", conversationIds: [], activeEngine: "codex", state: {},
  createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z", archived: false,
  ...(parent ? { managerAgentId: parent } : {}),
});

function detailWith(runStatuses: Array<"running" | "completed" | "failed">, workItemStatuses: Array<"running" | "waiting_approval" | "done"> = []): AgentDetailDto {
  return {
    runs: runStatuses.map((status, index) => ({ id: `run-${index}`, title: `Run ${index}`, status, updatedAt: `2026-07-12T00:00:0${index}.000Z` })),
    workItems: workItemStatuses.map((status, index) => ({ id: `item-${index}`, title: `Item ${index}`, status })),
  } as AgentDetailDto;
}

describe("visible agent status", () => {
  it("prioritizes a live run over projected state", () => {
    expect(deriveAgentStatus(detailWith(["completed"]), { running: true })).toBe("running");
  });

  it("keeps waiting work visible ahead of completed work", () => {
    expect(deriveAgentStatus(detailWith(["completed"], ["done", "waiting_approval"]))).toBe("waiting");
  });

  it("returns to idle when the latest projected Run completed", () => {
    const status = deriveAgentStatus(detailWith(["completed", "completed"]));
    expect(status).toBe("idle");
    expect(agentStatusLabel(status)).toBe("Idle");
  });

  it("keeps newly managed health identities visible before the roster refreshes", () => {
    const health = [{ agentId: "new-child", status: "running" }] as AgentHealthDto[];
    expect(mergeAgentStatuses([], health, new Map()).get("new-child")).toBe("running");
  });
});

describe("agent organization roster", () => {
  it("orders parents before children and fails closed for cyclic legacy data", () => {
    const rows = orderedAgentOrganization([
      organizationAgent("child", "Child", "parent"), organizationAgent("parent", "Parent"),
      organizationAgent("cycle-a", "Cycle A", "cycle-b"), organizationAgent("cycle-b", "Cycle B", "cycle-a"),
    ]);
    const parentIndex = rows.findIndex(({ agent }) => agent.id === "parent");
    const childIndex = rows.findIndex(({ agent }) => agent.id === "child");
    expect(parentIndex).toBeLessThan(childIndex);
    expect(rows[parentIndex]?.depth).toBe(0);
    expect(rows[childIndex]?.depth).toBe(1);
    expect(new Set(rows.map(({ agent }) => agent.id))).toEqual(new Set(["parent", "child", "cycle-a", "cycle-b"]));
    expect(rows.filter(({ agent }) => agent.id.startsWith("cycle")).every(({ depth }) => depth === 0)).toBe(true);
  });

  it("uses the spawn identity for custom specialists and preserves generic fallback", () => {
    const specialist = {
      ...organizationAgent("reviewer", "Skeptical Reviewer"),
      spawnPrompt: "Challenge the release plan and report risks. ".repeat(12),
    };
    expect(agentRoleProfile(specialist).role).toBe("Skeptical Reviewer");
    expect(agentRoleProfile(specialist).description).toMatch(/^Challenge the release plan/);
    expect(agentRoleProfile(specialist).description.length).toBeLessThanOrEqual(161);
    expect(agentRoleProfile(organizationAgent("generic", "General"))).toEqual({
      role: "Generalist", description: "General-purpose agent General",
    });
  });
});
