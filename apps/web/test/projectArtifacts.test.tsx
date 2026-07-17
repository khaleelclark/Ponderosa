import type { AgentDetailDto, AgentDto, ArtifactDto } from "@ponderosa/core";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ProjectArtifactsView } from "../src/components/ProjectArtifactsView";

describe("project artifacts view", () => {
  it("indexes files across agents and opens the canonical agent artifact", () => {
    const agent = {
      id: "agent-1",
      projectId: "project-1",
      title: "Cabrillo",
      conversationIds: [],
      activeEngine: "codex",
      state: {},
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
      archived: false,
    } satisfies AgentDto;
    const artifact = {
      id: "artifact-1",
      projectId: "project-1",
      agentId: agent.id,
      kind: "document",
      path: "reports/accessibility-audit.md",
      summary: "Accessibility audit",
      createdAt: "2026-07-17T10:01:00.000Z",
    } satisfies ArtifactDto;
    const onOpenArtifact = vi.fn();
    const detail = { artifacts: [artifact] } as unknown as AgentDetailDto;
    const view = create(<ProjectArtifactsView agents={[agent]} detailByAgentId={new Map([[agent.id, detail]])} onOpenArtifact={onOpenArtifact} />);

    expect(JSON.stringify(view.toJSON())).toContain("Accessibility audit");
    expect(JSON.stringify(view.toJSON())).toContain("reports/accessibility-audit.md");
    act(() => view.root.findByProps({ "aria-label": "Open Accessibility audit from Cabrillo" }).props.onClick());
    expect(onOpenArtifact).toHaveBeenCalledWith(agent.id, artifact.id);
    view.unmount();
  });
});
