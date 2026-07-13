import type { ThreadDetailDto, ThreadDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentStatusLabel, deriveAgentStatus, orderedAgentOrganization } from "../src/agents";
import { eligibleOrganizationParents } from "../src/components/AgentDetail";

const organizationAgent = (id: string, title: string, parent?: string): ThreadDto => ({
  id, title, projectId: "project", conversationIds: [], activeEngine: "codex", state: {},
  createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z", archived: false,
  ...(parent ? { managerAgentId: parent } : {}),
});

function detailWith(statuses: Array<"running" | "waiting_approval" | "done">): ThreadDetailDto {
  return {
    tasks: statuses.map((status, index) => ({ id: `task-${index}`, status })),
  } as ThreadDetailDto;
}

describe("visible agent status", () => {
  it("prioritizes a live run over projected state", () => {
    expect(deriveAgentStatus(detailWith(["done"]), { running: true })).toBe("running");
  });

  it("keeps waiting work visible ahead of completed work", () => {
    expect(deriveAgentStatus(detailWith(["done", "waiting_approval"]))).toBe("waiting");
  });

  it("returns to idle when all projected tasks are done", () => {
    const status = deriveAgentStatus(detailWith(["done", "done"]));
    expect(status).toBe("idle");
    expect(agentStatusLabel(status)).toBe("Idle");
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

  it("offers only stable active agents from the same project as parents", () => {
    const current = organizationAgent("current", "Current");
    const active = organizationAgent("active", "Active");
    const descendant = organizationAgent("descendant", "Descendant", "current");
    const archived = { ...organizationAgent("archived", "Archived"), archived: true };
    const foreign = { ...organizationAgent("foreign", "Foreign"), projectId: "other" };
    expect(eligibleOrganizationParents(current, [current, archived, foreign, descendant, active]).map((agent) => agent.id)).toEqual(["active"]);
  });
});
