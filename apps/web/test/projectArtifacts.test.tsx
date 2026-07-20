import { readFileSync } from "node:fs";
import type { AgentDto, ArtifactDto, ProjectDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { isTextArtifactPreview, ProjectArtifactsView } from "../src/components/ProjectArtifactsView";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: React.ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref, role: "dialog" }, children) : null),
  };
});

const projectArtifactsSource = readFileSync(new URL("../src/components/ProjectArtifactsView.tsx", import.meta.url), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("selects text/code files and renders their escaped, scrollable content without weakening document sandboxing", async () => {
    const agent = {
      id: "agent-1", projectId: "project-1", title: "Cabrillo", conversationIds: [], activeEngine: "codex", state: {},
      createdAt: "2026-07-17T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", archived: false,
    } satisfies AgentDto;
    const project = {
      id: "project-1", label: "Ponderosa", hostPath: "/repo", defaultEngine: "codex", createdAt: "2026-07-17T10:00:00.000Z",
    } satisfies ProjectDto;
    const markdown = {
      id: "readme", projectId: project.id, agentId: agent.id, kind: "generated_file", path: "generated/readme.md",
      summary: "Readme.md", mediaType: "text/markdown", previewUrl: "/api/projects/project-1/artifacts/readme/preview",
      downloadUrl: "/api/projects/project-1/artifacts/readme/download", createdAt: "2026-07-17T10:01:00.000Z",
    } satisfies ArtifactDto;
    const json = {
      ...markdown, id: "config", path: "generated/config.json", summary: "Config.json", mediaType: "application/json",
      previewUrl: "/api/projects/project-1/artifacts/config/preview", downloadUrl: "/api/projects/project-1/artifacts/config/download",
      createdAt: "2026-07-17T10:02:00.000Z",
    } satisfies ArtifactDto;
    vi.spyOn(api, "listProjectArtifacts").mockResolvedValue({ items: [markdown, json], history: { limit: 100, hasMore: false } });
    vi.spyOn(api, "getAgentWork").mockResolvedValue({ projectId: project.id, generatedAt: "2026-07-17T10:03:00.000Z", agents: [], traces: [], items: [] });
    vi.spyOn(api, "listDecisions").mockResolvedValue([]);
    const fetchPreview = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
      return new Response(String(input).includes("config") ? '{"safe":"<script>"}' : "# Readable\n\nconst answer = 42;", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchPreview);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ProjectArtifactsView
        projectId={project.id} project={project} agents={[agent]} healthByAgentId={new Map()}
        onOpenArtifact={vi.fn()} onOpenRun={vi.fn()} onOpenAgentWork={vi.fn()}
      /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(view.root.findAllByProps({ "aria-label": "Open Readme.md from Cabrillo" }).length).toBeGreaterThan(0));

    act(() => view.root.findByProps({ "aria-label": "Open Readme.md from Cabrillo" }).props.onClick());
    await vi.waitFor(() => expect(view.root.findByProps({ "data-testid": "artifact-text-preview" }).props.children).toContain("const answer = 42;"));
    const markdownPreview = view.root.findByProps({ "data-testid": "artifact-text-preview" });
    expect(markdownPreview.props.tabIndex).toBe(0);
    expect(markdownPreview.props.sx).toMatchObject({ overflow: "auto", whiteSpace: "pre-wrap", minWidth: 0 });

    act(() => view.root.findByProps({ "aria-label": "Open Config.json from Cabrillo" }).props.onClick());
    await vi.waitFor(() => expect(view.root.findByProps({ "data-testid": "artifact-text-preview" }).props.children).toContain("<script>"));
    expect(fetchPreview.mock.calls.some(([input]) => String(input).includes("readme/preview"))).toBe(true);
    expect(fetchPreview.mock.calls.some(([input]) => String(input).includes("config/preview"))).toBe(true);
    expect(isTextArtifactPreview("text/markdown")).toBe(true);
    expect(isTextArtifactPreview("application/json")).toBe(true);
    expect(isTextArtifactPreview("text/html")).toBe(false);
    expect(projectArtifactsSource).toContain('sandbox="allow-scripts"');
    expect(projectArtifactsSource).not.toContain("allow-same-origin");
    expect(projectArtifactsSource).toContain('referrerPolicy="no-referrer"');
    expect(view.root.findByProps({ "aria-label": "Download Config.json" }).props.href).toBe(json.downloadUrl);
    view.unmount();
    client.clear();
  });
});
import { readFileSync } from "node:fs";
