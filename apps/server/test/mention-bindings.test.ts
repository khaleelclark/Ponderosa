import { describe, expect, it } from "vitest";
import { resolveAgentMentionBindings } from "../src/mention-bindings";

describe("agent mention bindings", () => {
  it("does not recover a numeric reference as the sole recipient", () => {
    expect(resolveAgentMentionBindings(
      "See PR #301",
      ["hamilton"],
      [{ id: "hamilton", title: "Hamilton Grange" }],
    )).toEqual([]);
  });

  it("keeps a historical handle bound after its sole recipient is renamed", () => {
    expect(resolveAgentMentionBindings(
      "Thanks #John-Day-Fossil-Beds",
      ["john"],
      [{ id: "john", title: "John" }],
    )).toEqual([{ handle: "John-Day-Fossil-Beds", agentId: "john" }]);
  });

  it("binds an exact current-name match", () => {
    expect(resolveAgentMentionBindings(
      "Thanks #Hamilton-Grange",
      ["hamilton"],
      [{ id: "hamilton", title: "Hamilton Grange" }],
    )).toEqual([{ handle: "Hamilton-Grange", agentId: "hamilton" }]);
  });

  it("preserves an exact match for an agent with a numeric name", () => {
    expect(resolveAgentMentionBindings(
      "Ask #301",
      ["numeric-agent"],
      [{ id: "numeric-agent", title: "301" }],
    )).toEqual([{ handle: "301", agentId: "numeric-agent" }]);
  });

  it("fails closed when multiple renamed recipients make old handles ambiguous", () => {
    expect(resolveAgentMentionBindings(
      "Coordinate #Old-One and #Old-Two",
      ["one", "two"],
      [{ id: "one", title: "New One" }, { id: "two", title: "New Two" }],
    )).toEqual([]);
  });
});
