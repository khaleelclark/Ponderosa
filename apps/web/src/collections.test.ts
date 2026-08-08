import { describe, expect, test } from "vitest";
import { normalizeResetPages } from "./collections";

describe("live collection cursor recovery", () => {
  test("drops every page that predates the transparent reset", () => {
    const normalized = normalizeResetPages({
      pages: [
        { value: "old-1" },
        { value: "old-2" },
        { value: "fresh-1", reset: true },
        { value: "fresh-2" },
      ],
      pageParams: [undefined, "old-cursor", "stale-cursor", "fresh-cursor"],
    });
    expect(normalized.pages.map(page => page.value)).toEqual(["fresh-1", "fresh-2"]);
    expect(normalized.pageParams).toEqual(["stale-cursor", "fresh-cursor"]);
  });
});
