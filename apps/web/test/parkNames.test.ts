import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_NAMES, pickAgentName } from "../src/parkNames";

describe("agent name configuration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("contains 423 unique shortened National Park System names", () => {
    expect(AGENT_NAMES).toHaveLength(423);
    expect(new Set(AGENT_NAMES.map((name) => name.toLowerCase())).size).toBe(423);
    expect(AGENT_NAMES).toContain("Antietam");
    expect(AGENT_NAMES).toContain("Gates of the Arctic");
    expect(AGENT_NAMES).toContain("Wolf Trap");
  });

  it("selects a complete configured name", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([])).toBe("Antietam");
  });

  it("treats configured names as taken case-insensitively", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([" antietam "])).toBe("Big Hole");
  });
});
