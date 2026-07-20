import type { AgentDto, ArtifactDto, ProjectDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ProjectArtifactsView } from "../src/components/ProjectArtifactsView";

const projectArtifactsSource = readFileSync(new URL("../src/components/ProjectArtifactsView.tsx", import.meta.url), "utf8");

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
    const onOpenRun = vi.fn();
    const project = {
      id: "project-1", label: "Ponderosa", hostPath: "/repo", defaultEngine: "codex", createdAt: "2026-07-17T10:00:00.000Z",
      instructions: "Ship a durable Agent organization.",
    } satisfies ProjectDto;
    const command = { ...artifact, id: "command-1", kind: "log", path: "events/command.md", summary: "pnpm test" } satisfies ArtifactDto;
    const download = {
      ...artifact,
      id: "download-1",
      kind: "generated_file",
      path: "generated/report.pdf",
      summary: "Final report.pdf",
      previewUrl: "/api/projects/project-1/artifacts/download-1/preview",
      downloadUrl: "/api/projects/project-1/artifacts/download-1/download",
      executionId: "run-download-1",
    } satisfies ArtifactDto;
    vi.spyOn(api, "listProjectArtifacts").mockResolvedValue({
      items: [artifact, command, download],
      history: { limit: 100, hasMore: false },
    });
    vi.spyOn(api, "getAgentWork").mockResolvedValue({
      projectId: project.id, generatedAt: "2026-07-17T10:02:00.000Z", agents: [], traces: [], items: [],
    });
    vi.spyOn(api, "listDecisions").mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ProjectArtifactsView
        projectId="project-1"
        project={project}
        agents={[agent]}
        healthByAgentId={new Map()}
        onOpenArtifact={onOpenArtifact}
        onOpenRun={onOpenRun}
        onOpenAgentWork={() => undefined}
      /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("Accessibility audit"));

    expect(JSON.stringify(view.toJSON())).toContain("reports/accessibility-audit.md");
    expect(JSON.stringify(view.toJSON())).toContain("Final report.pdf");
    expect(JSON.stringify(view.toJSON())).toContain("Project overview");
    expect(JSON.stringify(view.toJSON())).toContain("Ship a durable Agent organization.");
    expect(JSON.stringify(view.toJSON())).toContain("Download");
    expect(JSON.stringify(view.toJSON())).not.toContain("pnpm test");
    act(() => view.root.findByProps({ "aria-label": "Open Accessibility audit from Cabrillo" }).props.onClick());
    expect(onOpenArtifact).toHaveBeenCalledWith(agent.id, artifact.id);
    const previewButton = view.root.findByProps({ "aria-label": "Preview Final report.pdf" });
    expect(previewButton.props.onClick).toEqual(expect.any(Function));
    expect(previewButton.props.href).toBeUndefined();
    expect(previewButton.props.target).toBeUndefined();
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(onOpenArtifact).toHaveBeenCalledTimes(1);
    expect(projectArtifactsSource).toContain('sandbox="allow-scripts"');
    expect(projectArtifactsSource).not.toContain("allow-same-origin");
    expect(projectArtifactsSource).toContain('referrerPolicy="no-referrer"');
    expect(projectArtifactsSource).toContain("Open originating Run");
    view.unmount();
    client.clear();
  });
});
import { readFileSync } from "node:fs";
