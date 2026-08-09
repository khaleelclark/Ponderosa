import type { AgentDetailDto } from "@ponderosa/core";
import { describe, expect, test } from "vitest";
import { boundLiveAgentTelemetry } from "./agentLiveProjection";

describe("live Agent telemetry window", () => {
  test("retains only the canonical recent page while an Agent stays open", () => {
    const detail = {
      runOutput: Array.from({ length: 80 }, (_, seq) => ({ seq })),
      activity: Array.from({ length: 80 }, (_, seq) => ({ seq })),
      changedFiles: [],
      runs: [],
      workItems: [],
      artifacts: [],
      telemetryHistory: {
        runOutput: { limit: 25, hasMore: true },
        activity: { limit: 25, hasMore: true },
      },
    } as unknown as AgentDetailDto;

    const bounded = boundLiveAgentTelemetry(detail);
    expect(bounded.runOutput).toHaveLength(25);
    expect(bounded.runOutput[0]?.seq).toBe(55);
    expect(bounded.activity).toHaveLength(25);
    expect(bounded.activity[0]?.seq).toBe(55);
  });
});
