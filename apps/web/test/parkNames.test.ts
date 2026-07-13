import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_NAMES, pickAgentName } from "../src/parkNames";

describe("agent name configuration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("contains all 433 National Park System units", () => {
    expect(AGENT_NAMES).toHaveLength(433);
    expect(new Set(AGENT_NAMES.map((name) => name.toLowerCase())).size).toBe(433);
    expect(AGENT_NAMES).toContain("Antietam National Battlefield");
    expect(AGENT_NAMES).toContain("Gates of the Arctic National Park");
    expect(AGENT_NAMES).toContain("Wolf Trap National Park for the Performing Arts");
  });

  it("selects a complete configured name", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([])).toBe("Antietam National Battlefield");
  });

  it("treats configured names as taken case-insensitively", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([" antietam national battlefield "])).toBe("Big Hole National Battlefield");
  });
});
