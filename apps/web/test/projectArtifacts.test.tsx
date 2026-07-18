import type { AgentDetailDto, AgentDto, ArtifactDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ProjectArtifactsView } from "../src/components/ProjectArtifactsView";

describe("project artifacts view", () => {
  it("indexes downloadable project outputs without showing command logs", async () => {
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
    const command = { ...artifact, id: "command-1", kind: "log", path: "events/command.md", summary: "pnpm test" } satisfies ArtifactDto;
    const download = {
      ...artifact,
      id: "download-1",
      kind: "generated_file",
      path: "generated/report.pdf",
      summary: "Final report.pdf",
      previewUrl: "/api/projects/project-1/artifacts/download-1/preview",
      downloadUrl: "/api/projects/project-1/artifacts/download-1/download",
    } satisfies ArtifactDto;
    vi.spyOn(api, "listProjectArtifacts").mockResolvedValue([download]);
    const detail = { artifacts: [artifact, command, download] } as unknown as AgentDetailDto;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ProjectArtifactsView projectId="project-1" agents={[agent]} detailByAgentId={new Map([[agent.id, detail]])} onOpenArtifact={onOpenArtifact} /></QueryClientProvider>);
    });

    expect(JSON.stringify(view.toJSON())).toContain("Accessibility audit");
    expect(JSON.stringify(view.toJSON())).toContain("reports/accessibility-audit.md");
    expect(JSON.stringify(view.toJSON())).toContain("Final report.pdf");
    expect(JSON.stringify(view.toJSON())).toContain("Download");
    expect(JSON.stringify(view.toJSON())).not.toContain("pnpm test");
    act(() => view.root.findByProps({ "aria-label": "Open Accessibility audit from Cabrillo" }).props.onClick());
    expect(onOpenArtifact).toHaveBeenCalledWith(agent.id, artifact.id);
    view.unmount();
    client.clear();
  });
});
