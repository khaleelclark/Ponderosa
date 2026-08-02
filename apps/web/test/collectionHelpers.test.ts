import { describe, expect, it } from "vitest";
import type { AgentDto, ArtifactDto } from "@ponderosa/core";
import {
  agentHasCollapsedAncestor,
  agentHierarchyContextIds,
  matchesAgentStatusFilters,
} from "../src/components/AgentsTab.helpers";
import {
  matchesProjectFileCategories,
  projectArtifactGroup,
  projectFileCategory,
} from "../src/components/ProjectArtifactsView.helpers";

const agent = (
  id: string,
  managerAgentId?: string,
  conversationIds: string[] = [],
): AgentDto => ({
  id,
  projectId: "project",
  title: id,
  role: "agent",
  engine: "codex",
  activeEngine: "codex",
  conversationIds,
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(managerAgentId ? { managerAgentId } : {}),
});

const artifact = (path: string, kind: ArtifactDto["kind"] = "generated_file") =>
  ({ path, kind } as ArtifactDto);

describe("Agent collection helpers", () => {
  it("retains every hierarchy ancestor needed to explain a matching descendant", () => {
    const agents = [agent("root"), agent("middle", "root"), agent("leaf", "middle")];
    expect(agentHierarchyContextIds(agents, new Set(["leaf"]))).toEqual(
      new Set(["leaf", "middle", "root"]),
    );
  });

  it("detects collapsed ancestors without looping through malformed cycles", () => {
    const agents = [agent("a", "b"), agent("b", "a")];
    const byId = new Map(agents.map(item => [item.id, item]));
    expect(agentHasCollapsedAncestor(agents[0]!, byId, new Set(["b"]))).toBe(true);
    expect(agentHasCollapsedAncestor(agents[0]!, byId, new Set())).toBe(false);
  });

  it("keeps unassigned filtering distinct from runtime status", () => {
    expect(matchesAgentStatusFilters(agent("idle"), "idle", ["unassigned"]))
      .toBe(true);
    expect(matchesAgentStatusFilters(agent("assigned", undefined, ["chat"]), "idle", ["unassigned"]))
      .toBe(false);
    expect(matchesAgentStatusFilters(agent("decision"), "needs_decision", ["needs_decision"]))
      .toBe(true);
  });
});

describe("Project artifact helpers", () => {
  it("classifies common files and leaves unknown extensions in Other", () => {
    expect(projectFileCategory(artifact("src/App.tsx"))).toBe("code");
    expect(projectFileCategory(artifact("reports/result.pdf"))).toBe("documents");
    expect(projectFileCategory(artifact("build/package.unknown"))).toBe("other");
  });

  it("applies selected categories without changing result grouping", () => {
    expect(matchesProjectFileCategories(artifact("data.json"), ["data"])).toBe(true);
    expect(matchesProjectFileCategories(artifact("data.json"), ["images"])).toBe(false);
    expect(projectArtifactGroup("test_report")).toBe("Results");
    expect(projectArtifactGroup("generated_file")).toBe("Modified & Created Files");
  });
});
