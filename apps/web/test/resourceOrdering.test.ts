import { describe, expect, it } from "vitest";
import { orderByStableIds, reorderStableIds } from "../src/components/WorkspaceSidebar";

describe("resource ordering", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("applies a partial persisted order and retains new resources", () => {
    expect(orderByStableIds(items, ["c", "a"], (item) => item.id).map((item) => item.id))
      .toEqual(["c", "a", "b"]);
  });

  it("moves chats, Agents, and Triggers by stable ID", () => {
    expect(reorderStableIds(["a", "b", "c"], ["a", "b", "c"], "c", "a"))
      .toEqual(["c", "a", "b"]);
  });
});
