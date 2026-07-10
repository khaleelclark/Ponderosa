import { afterEach, describe, expect, it, vi } from "vitest";

import { pickAgentName } from "../src/parkNames";

describe("pickAgentName", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses complete names for multi-word National Parks", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName(["Acadia", "American Samoa", "Arches", "Badlands", "Big Bend", "Biscayne", "Black Canyon of the Gunnison"]))
      .toBe("Bryce Canyon");

    expect(pickAgentName(["Acadia", "American Samoa", "Arches", "Badlands"])).toBe("Big Bend");
  });

  it("includes National Monuments in the available name pool", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(pickAgentName([])).toBe("Wupatki");
  });

  it("treats complete names as taken case-insensitively", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickAgentName([" acadia "])).toBe("American Samoa");
  });
});
