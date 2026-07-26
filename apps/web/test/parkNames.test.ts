import { afterEach, describe, expect, it, vi } from "vitest";

import { pickAgentName } from "../src/parkNames";

describe("agent name configuration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("selects a complete configured name", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([])).toBe("Acadia");
  });

  it("treats configured names as taken case-insensitively", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([" acadia "])).toBe("Alaska");
  });
});
