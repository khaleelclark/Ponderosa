import type { ThreadDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentStatusLabel, deriveAgentStatus } from "../src/agents";

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

  it("reports completion only when all projected tasks are done", () => {
    const status = deriveAgentStatus(detailWith(["done", "done"]));
    expect(status).toBe("completed");
    expect(agentStatusLabel(status)).toBe("Completed");
  });
});
