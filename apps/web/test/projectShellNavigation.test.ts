import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentBackRoute } from "../src/components/ProjectShell";

const projectShellSource = readFileSync(new URL("../src/components/ProjectShell.tsx", import.meta.url), "utf8");

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

  it("does not hydrate every Agent's full history from the Project shell", () => {
    expect(projectShellSource).not.toContain("useQueries");
    expect(projectShellSource).not.toContain("detailByAgentId");
    expect(projectShellSource).not.toContain("api.getAgent(");
  });
});
