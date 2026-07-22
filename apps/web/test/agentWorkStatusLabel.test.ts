import { describe, expect, it } from "vitest";
import { agentWorkStateLabel } from "../src/components/AgentWorkInspector";

describe("Agent Work status labels", () => {
  it.each([["attached", "Attached"], ["consumed", "Consumed"], ["retry_pending", "Retry Pending"]])("renders %s as %s", (state, label) => {
    expect(agentWorkStateLabel(state)).toBe(label);
  });
});
