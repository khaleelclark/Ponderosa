import { describe, expect, it } from "vitest";
import { orderHomeResources, reorderHomeResources } from "../src/components/HomeView";

describe("Home custom ordering", () => {
  const items = [{ id: "project:a" }, { id: "chat:b" }, { id: "agent:c" }];

  it("honors persisted stable resource keys while retaining newly discovered work", () => {
    expect(orderHomeResources(items, ["agent:c", "project:a"]).map((item) => item.id))
      .toEqual(["agent:c", "project:a", "chat:b"]);
  });

  it("persists a drag across mixed resource types", () => {
    expect(reorderHomeResources([], items.map((item) => item.id), "agent:c", "project:a"))
      .toEqual(["agent:c", "project:a", "chat:b"]);
  });
});
