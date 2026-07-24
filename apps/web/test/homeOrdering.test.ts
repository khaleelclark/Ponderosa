import { describe, expect, it } from "vitest";
import { reorderStableIds } from "../src/resourcePreferences";

describe("Home custom ordering", () => {
  const items = [{ id: "project:a" }, { id: "chat:b" }, { id: "agent:c" }];

  it("persists a drag across mixed resource types", () => {
    expect(reorderStableIds([], items.map((item) => item.id), "agent:c", "project:a"))
      .toEqual(["agent:c", "project:a", "chat:b"]);
  });
});
