import { readFileSync } from "node:fs";
import type { AgentDto, ArtifactDto, ProjectDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { copyText } from "../src/clipboard";
import {
  createdFileUnifiedDiff,
  isTextArtifactPreview,
  projectArtifactGroup,
  projectFileCategory,
  ProjectArtifactsView,
  recordedArtifactDiff,
} from "../src/components/ProjectArtifactsView";

vi.mock("../src/clipboard", () => ({ copyText: vi.fn() }));

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
  it("derives deterministic file categories and line-oriented created-file diffs", () => {
    const artifact = (path: string): ArtifactDto => ({
      id: path, agentId: "agent-1", kind: "generated_file", path, createdAt: "2026-07-20T00:00:00.000Z",
    });
    expect(projectFileCategory(artifact("src/App.TSX"))).toBe("code");
    expect(projectFileCategory(artifact("reports/summary.pdf"))).toBe("documents");
    expect(projectFileCategory(artifact("config/settings.yaml"))).toBe("data");
    expect(projectFileCategory(artifact("screens/hero.avif"))).toBe("images");
    expect(projectFileCategory(artifact("bundles/release.zip"))).toBe("archives");
    expect(projectFileCategory(artifact("output/README"))).toBe("other");
    expect(createdFileUnifiedDiff("src/new.ts", "const value = 1;\n")).toContain("--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+const value = 1;");
    expect(recordedArtifactDiff({ ...artifact("diff.patch"), kind: "diff", summary: "edit src/a.ts" }, "@@ -1 +1 @@\n-old\n+new")).toContain("+new");
    expect(recordedArtifactDiff({ ...artifact("diff.patch"), kind: "diff", summary: "edit src/a.ts" }, "raw current file body")).toBeUndefined();
  });

  it("indexes files, results, and copyable commands without changing command text", async () => {
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
    const changedFile = { ...artifact, id: "diff-1", kind: "diff", path: "diffs/src-app-ts.diff", sourcePath: "src/app.ts", summary: "edit src/app.ts" } satisfies ArtifactDto;
    const testResult = { ...artifact, id: "test-1", kind: "test_report", path: "results/web-tests.md", summary: "Web tests passed" } satisfies ArtifactDto;
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
      items: [artifact, command, changedFile, testResult, download],
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
    expect(JSON.stringify(view.toJSON())).toContain("Edit · app.ts");
    expect(JSON.stringify(view.toJSON())).toContain("Web tests passed");
    expect(JSON.stringify(view.toJSON())).toContain("Modified & Created Files");
    expect(JSON.stringify(view.toJSON())).toContain("Results");
    expect(JSON.stringify(view.toJSON())).toContain("Commands");
    expect(JSON.stringify(view.toJSON())).toContain("Project overview");
    expect(JSON.stringify(view.toJSON())).toContain("Ship a durable Agent organization.");
    expect(JSON.stringify(view.toJSON())).toContain("Download");
    expect(JSON.stringify(view.toJSON())).toContain("pnpm test");
    expect(projectArtifactGroup("diff")).toBe("Modified & Created Files");
    expect(projectArtifactGroup("test_report")).toBe("Results");
    expect(projectArtifactGroup("log")).toBe("Commands");
    vi.mocked(copyText).mockResolvedValue();
    await act(async () => view.root.findByProps({ "aria-label": "Copy command" }).props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    expect(copyText).toHaveBeenCalledWith("pnpm test");
    expect(view.root.findByProps({ "aria-live": "polite" }).props.children).toBe("Command copied");
    vi.mocked(copyText).mockRejectedValueOnce(new Error("clipboard denied"));
    await act(async () => view.root.findByProps({ "aria-label": "Copy command" }).props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    expect(view.root.findByProps({ "aria-live": "polite" }).props.children).toBe("Copy command failed");
    act(() => view.root.findByProps({ "aria-label": "Open Accessibility audit from Cabrillo" }).props.onClick());
    expect(onOpenArtifact).toHaveBeenCalledWith(agent.id, artifact.id);
    const previewButton = view.root.findByProps({ "aria-label": "Preview Final report.pdf" });
    expect(previewButton.props.onClick).toEqual(expect.any(Function));
    expect(previewButton.props.href).toBeUndefined();
    expect(previewButton.props.target).toBeUndefined();
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(onOpenArtifact).toHaveBeenCalledTimes(1);
    act(() => view.root.findByProps({ labelId: "project-file-category-label" }).props.onChange({ target: { value: "code" } }));
    expect(JSON.stringify(view.toJSON())).toContain("Edit · app.ts");
    expect(JSON.stringify(view.toJSON())).not.toContain("Accessibility audit");
    expect(JSON.stringify(view.toJSON())).toContain("pnpm test");
    expect(projectArtifactsSource).toContain('sandbox="allow-scripts"');
    expect(projectArtifactsSource).not.toContain("allow-same-origin");
    expect(projectArtifactsSource).toContain('referrerPolicy="no-referrer"');
    expect(projectArtifactsSource).toContain("Open originating Run");
    view.unmount();
    client.clear();
  });

  it("selects different text/code files and renders each as a highlighted created-file diff", async () => {
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
    await vi.waitFor(() => expect(view.root.findByProps({ "aria-label": "Created-file diff for Readme.md" })).toBeTruthy());
    expect(JSON.stringify(view.toJSON())).toContain("+const answer = 42;");
    expect(view.root.findAllByProps({ "data-diff-line-kind": "addition" }).length).toBeGreaterThan(0);

    act(() => view.root.findByProps({ "aria-label": "Open Config.json from Cabrillo" }).props.onClick());
    await vi.waitFor(() => expect(view.root.findByProps({ "aria-label": "Created-file diff for Config.json" })).toBeTruthy());
    expect(view.root.findAllByProps({ "aria-label": "Created-file diff for Readme.md" })).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).toContain('+{\\"safe\\":\\"<script>\\"}');
    expect(fetchPreview.mock.calls.some(([input]) => String(input).includes("readme/preview"))).toBe(true);
    expect(fetchPreview.mock.calls.some(([input]) => String(input).includes("config/preview"))).toBe(true);
    expect(isTextArtifactPreview("text/markdown")).toBe(true);
    expect(isTextArtifactPreview("application/json")).toBe(true);
    expect(isTextArtifactPreview("text/html")).toBe(false);
    expect(projectFileCategory(markdown)).toBe("documents");
    expect(projectFileCategory(json)).toBe("data");
    expect(projectArtifactsSource).toContain('sandbox="allow-scripts"');
    expect(projectArtifactsSource).not.toContain("allow-same-origin");
    expect(projectArtifactsSource).toContain('referrerPolicy="no-referrer"');
    expect(view.root.findByProps({ "aria-label": "Download Config.json" }).props.href).toBe(json.downloadUrl);
    view.unmount();
    client.clear();
  });

  it("changes the selected canonical diff when two different files are chosen", async () => {
    const agent = {
      id: "agent-1", projectId: "project-1", title: "Cabrillo", conversationIds: [], activeEngine: "codex", state: {},
      createdAt: "2026-07-17T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", archived: false,
    } satisfies AgentDto;
    const project = {
      id: "project-1", label: "Ponderosa", hostPath: "/repo", defaultEngine: "codex", createdAt: "2026-07-17T10:00:00.000Z",
    } satisfies ProjectDto;
    const first = {
      id: "first-diff", projectId: project.id, agentId: agent.id, kind: "diff", path: "artifacts/first.patch",
      sourcePath: "src/first.ts", summary: "edit src/first.ts", createdAt: "2026-07-17T10:01:00.000Z",
    } satisfies ArtifactDto;
    const second = {
      ...first, id: "second-diff", path: "artifacts/second.patch", sourcePath: "src/second.ts", summary: "edit src/second.ts",
      createdAt: "2026-07-17T10:02:00.000Z",
    } satisfies ArtifactDto;
    const binary = {
      ...first, id: "binary-diff", path: "artifacts/image.patch", sourcePath: "assets/image.png", summary: "edit assets/image.png",
      createdAt: "2026-07-17T10:03:00.000Z",
    } satisfies ArtifactDto;
    vi.spyOn(api, "listProjectArtifacts").mockResolvedValue({ items: [first, second, binary], history: { limit: 100, hasMore: false } });
    vi.spyOn(api, "getArtifact").mockImplementation(async (_agentId, artifactId) => ({
      ...(artifactId === first.id ? first : artifactId === second.id ? second : binary),
      content: artifactId === first.id
        ? "@@ -1 +1 @@\n-old first\n+new first"
        : artifactId === second.id ? "@@ -1 +1 @@\n-old second\n+new second" : "Binary files differ",
      contentType: "diff",
    }));
    vi.spyOn(api, "getAgentWork").mockResolvedValue({ projectId: project.id, generatedAt: "2026-07-17T10:03:00.000Z", agents: [], traces: [], items: [] });
    vi.spyOn(api, "listDecisions").mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ProjectArtifactsView
        projectId={project.id} project={project} agents={[agent]} healthByAgentId={new Map()}
        onOpenArtifact={vi.fn()} onOpenRun={vi.fn()} onOpenAgentWork={vi.fn()}
      /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(view.root.findAllByProps({ "aria-label": "Open Edit · first.ts from Cabrillo" })).toHaveLength(1));

    act(() => view.root.findByProps({ "aria-label": "Open Edit · first.ts from Cabrillo" }).props.onClick());
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("+new first"));
    expect(view.root.findAllByProps({ "data-diff-line-kind": "addition" }).length).toBeGreaterThan(0);

    act(() => view.root.findByProps({ "aria-label": "Open Edit · second.ts from Cabrillo" }).props.onClick());
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("+new second"));
    expect(JSON.stringify(view.toJSON())).not.toContain("+new first");
    expect(api.getArtifact).toHaveBeenCalledWith(agent.id, first.id);
    expect(api.getArtifact).toHaveBeenCalledWith(agent.id, second.id);

    act(() => view.root.findByProps({ "aria-label": "Open Edit · image.png from Cabrillo" }).props.onClick());
    await vi.waitFor(() => expect(JSON.stringify(view.toJSON())).toContain("does not contain a line-oriented diff"));
    expect(JSON.stringify(view.toJSON())).not.toContain("Binary files differ");
    view.unmount();
    client.clear();
  });
});
