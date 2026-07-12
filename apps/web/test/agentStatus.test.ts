import type { ThreadDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentStatusLabel, deriveAgentStatus } from "../src/agents";

function detailWith(status: ThreadDetailDto["thread"]["status"]): ThreadDetailDto {
  return {
    thread: { status },
  } as ThreadDetailDto;
}

describe("visible agent status", () => {
  it("uses the canonical thread lifecycle status", () => {
    expect(deriveAgentStatus(detailWith("running"))).toBe("running");
  });

  it("keeps waiting distinct from task history", () => {
    expect(deriveAgentStatus(detailWith("waiting"))).toBe("waiting");
  });

  it("reports a finished turn as idle rather than completed", () => {
    const status = deriveAgentStatus(detailWith("idle"));
    expect(status).toBe("idle");
    expect(agentStatusLabel(status)).toBe("Idle");
  });
});
