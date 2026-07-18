import { describe, expect, it } from "vitest";
import { agentBackRoute } from "../src/components/ProjectShell";

describe("agent detail return navigation", () => {
  it("returns drawer-opened agent details to their originating Project chat", () => {
    expect(agentBackRoute("project", { conversationId: "conversation", reopenRoster: true })).toEqual({
      kind: "conversation",
      projectId: "project",
      conversationId: "conversation",
    });
  });

  it("returns ordinary project agent details to the project agent list", () => {
    expect(agentBackRoute("project")).toEqual({ kind: "agents", projectId: "project" });
  });
});
