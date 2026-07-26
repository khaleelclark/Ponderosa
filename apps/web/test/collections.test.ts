import { describe, expect, it } from "vitest";
import { compactDefined } from "../src/collections";

describe("compactDefined", () => {
  it("removes nullish cache entries without removing falsey values", () => {
    expect(compactDefined([undefined, { id: "one" }, null, { id: "two" }])).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
    expect(compactDefined([0, false, ""])).toEqual([0, false, ""]);
  });
});
