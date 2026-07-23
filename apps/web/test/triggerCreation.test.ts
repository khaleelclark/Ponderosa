import type { AgentDto, ProjectDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { routeForTriggerAgentSelection, triggerAgentDestinations } from "../src/triggerCreation";

const projects: ProjectDto[] = [
  { id: "alpha", label: "Alpha", hostPath: "/alpha", defaultEngine: "codex", createdAt: "2026-07-01T00:00:00.000Z" },
  { id: "beta", label: "Beta", hostPath: "/beta", defaultEngine: "codex", createdAt: "2026-07-01T00:00:00.000Z" },
];

const agent = (id: string, projectId: string, conversationIds: string[], archived = false): AgentDto => ({
  id,
  projectId,
  title: id,
  conversationIds,
  activeEngine: "codex",
  state: {},
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  archived,
});

describe("global Agent-first Trigger creation", () => {
  it("lists active Agents with their owning Projects and never supplies a default selection", () => {
    const destinations = triggerAgentDestinations(projects, [
      [agent("alpha-agent", "alpha", ["alpha-chat"]), agent("archived", "alpha", ["alpha-chat"], true)],
      [agent("beta-agent", "beta", ["beta-chat"])],
    ]);

    expect(destinations.map(({ project, agent: item }) => [project.id, item.id])).toEqual([
      ["alpha", "alpha-agent"],
      ["beta", "beta-agent"],
    ]);
    expect(routeForTriggerAgentSelection("", destinations)).toBeUndefined();
  });

  it("continues only with the explicitly selected chat-assigned Agent", () => {
    const destinations = triggerAgentDestinations(projects, [
      [agent("ready", "alpha", ["alpha-chat"]), agent("unassigned", "alpha", [])],
      [],
    ]);

    expect(routeForTriggerAgentSelection("ready", destinations)).toEqual({
      kind: "agent",
      projectId: "alpha",
      agentId: "ready",
      view: "triggers",
      createTrigger: true,
    });
    expect(routeForTriggerAgentSelection("unassigned", destinations)).toBeUndefined();
    expect(routeForTriggerAgentSelection("missing", destinations)).toBeUndefined();
  });
});
