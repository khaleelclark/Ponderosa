import { describe, expect, it } from "vitest";
import { projectDropPreferencePatch, projectMovePreferencePatch, reorderProjectIds } from "../src/components/WorkspaceOverview";

describe("custom project ordering", () => {
  it("moves a dragged project before its drop target", () => {
    expect(reorderProjectIds(["alpha", "beta", "gamma"], "gamma", "alpha"))
      .toEqual(["gamma", "alpha", "beta"]);
    expect(reorderProjectIds(["alpha", "beta", "gamma"], "alpha", "gamma"))
      .toEqual(["beta", "alpha", "gamma"]);
    expect(reorderProjectIds(["alpha", "beta", "gamma"], "alpha", "gamma", "after"))
      .toEqual(["beta", "gamma", "alpha"]);
  });

  it("leaves invalid or no-op drops unchanged", () => {
    const order = ["alpha", "beta"];
    expect(reorderProjectIds(order, "alpha", "alpha")).toBe(order);
    expect(reorderProjectIds(order, "missing", "alpha")).toBe(order);
    expect(reorderProjectIds(order, "alpha", "missing")).toBe(order);
  });

  it("switches any current sort to a persisted custom order after a valid drop", () => {
    expect(projectDropPreferencePatch(["alpha", "beta", "gamma"], "gamma", "alpha")).toEqual({
      projectSort: "custom",
      projectOrder: ["gamma", "alpha", "beta"],
    });
    expect(projectDropPreferencePatch(["alpha", "beta"], "alpha", "alpha")).toBeUndefined();
  });

  it("persists accessible one-position moves and rejects boundary moves", () => {
    expect(projectMovePreferencePatch(["alpha", "beta", "gamma"], "beta", "before")).toEqual({
      projectSort: "custom",
      projectOrder: ["beta", "alpha", "gamma"],
    });
    expect(projectMovePreferencePatch(["alpha", "beta", "gamma"], "beta", "after")).toEqual({
      projectSort: "custom",
      projectOrder: ["alpha", "gamma", "beta"],
    });
    expect(projectMovePreferencePatch(["alpha", "beta"], "alpha", "before")).toBeUndefined();
    expect(projectMovePreferencePatch(["alpha", "beta"], "beta", "after")).toBeUndefined();
  });
});
