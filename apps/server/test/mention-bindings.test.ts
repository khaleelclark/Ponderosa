import { describe, expect, it } from "vitest";
import { resolveAgentMentionBindings } from "../src/mention-bindings";

describe("agent mention bindings", () => {
  it("keeps a historical handle bound after its sole recipient is renamed", () => {
    expect(resolveAgentMentionBindings(
      "Thanks #John-Day-Fossil-Beds",
      ["john"],
      [{ id: "john", title: "John" }],
    )).toEqual([{ handle: "John-Day-Fossil-Beds", agentId: "john" }]);
  });

  it("fails closed when multiple renamed recipients make old handles ambiguous", () => {
    expect(resolveAgentMentionBindings(
      "Coordinate #Old-One and #Old-Two",
      ["one", "two"],
      [{ id: "one", title: "New One" }, { id: "two", title: "New Two" }],
    )).toEqual([]);
  });
});
