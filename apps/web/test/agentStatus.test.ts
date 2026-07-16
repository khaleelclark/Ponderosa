import type { AgentDetailDto, AgentDto, AgentHealthDto } from "@ponderosa/core";
import { agentRoleProfile } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentActivity, agentRosterIndent, agentStatusLabel, deriveAgentStatus, mergeAgentStatuses, orderedAgentOrganization } from "../src/agents";
import { directAgentDeliveryNotice, eligibleOrganizationParents } from "../src/components/AgentDetail";

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
  it("does not claim a steer was delivered before provider acknowledgement", () => {
    expect(directAgentDeliveryNotice({ queued: true, position: 3 })).toBeUndefined();
    expect(directAgentDeliveryNotice({ queued: true, position: 3 }, "queue")).toBe(
      "Queued in position 3; it will start when the current response finishes.",
    );
    expect(directAgentDeliveryNotice({ queued: false, runId: "run", mode: "steer", steered: true })).toBe(
      "Steered into the active turn.",
    );
    expect(directAgentDeliveryNotice({ queued: false, runId: "run", mode: "continue" })).toBeUndefined();
  });

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

  it("shows only actionable current activity, never completed history", () => {
    expect(agentActivity(detailWith(["completed"]))).toBeUndefined();
    expect(agentActivity(detailWith(["completed", "running"]))).toBe("Run 1");
    expect(agentActivity(detailWith(["completed"], ["done", "waiting_approval"]))).toBe("Item 1");
  });

  it("keeps newly managed health identities visible before the roster refreshes", () => {
    const health = [{ agentId: "new-child", status: "running" }] as AgentHealthDto[];
    expect(mergeAgentStatuses([], health, new Map()).get("new-child")).toBe("running");
  });
});

describe("agent organization roster", () => {
  it("caps indentation so deep rows stay inside the fixed-width drawer", () => {
    expect([0, 1, 2, 3, 8].map(agentRosterIndent)).toEqual([0, 2, 4, 6, 6]);
  });

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
