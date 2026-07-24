import type { WorkspacePreferencesDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import {
  reorderStableIds,
  resourcePreferenceKey,
  sortWorkspaceResources,
  starredWorkspaceResources,
  toggleWorkspaceResourceStar,
} from "../src/resourcePreferences";

describe("resource ordering", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves chats, Agents, and Triggers by stable ID", () => {
    expect(reorderStableIds(["a", "b", "c"], ["a", "b", "c"], "c", "a"))
      .toEqual(["c", "a", "b"]);
  });

  it("sorts every noun by recent, alphabetical, or persisted custom order", () => {
    const dated = [
      { id: "a", title: "Zulu", updatedAt: "2026-07-20T00:00:00.000Z" },
      { id: "b", title: "Alpha", updatedAt: "2026-07-21T00:00:00.000Z" },
    ];
    const sort = (mode: "last_used" | "alphabetical" | "custom", order: string[] = []) =>
      sortWorkspaceResources(dated, mode, order, (item) => item.id, (item) => item.title, (item) => item.updatedAt).map((item) => item.id);
    expect(sort("last_used")).toEqual(["b", "a"]);
    expect(sort("alphabetical")).toEqual(["b", "a"]);
    expect(sort("custom", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("keeps legacy Project stars while toggling namespaced resources", () => {
    const preferences = { starredProjectIds: ["alpha"], starredResourceIds: ["agent:reviewer"] } as WorkspacePreferencesDto;
    expect(starredWorkspaceResources(preferences)).toEqual(new Set(["project:alpha", "agent:reviewer"]));
    expect(toggleWorkspaceResourceStar(preferences, "conversation", "chat-alpha")).toEqual({
      starredProjectIds: ["alpha"],
      starredResourceIds: ["agent:reviewer", resourcePreferenceKey("project", "alpha"), "conversation:chat-alpha"],
    });
  });
});
