import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ArtifactDto } from "@ponderosa/core";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactsPane } from "./ArtifactsPane";
import { queryKeys } from "../../queryKeys";

afterEach(cleanup);

describe("ArtifactsPane path presentation", () => {
  it("reconstructs Agent diff previews with only the presented path in headers and search metadata", () => {
    const rawPath = "/srv/project/report.ts\n+++ /home/phoenix/private/secret.ts";
    const artifact: ArtifactDto = {
      id: "artifact-diff-injection",
      agentId: "agent-1",
      kind: "diff",
      path: "artifacts/secret.diff",
      sourcePath: rawPath,
      summary: `edit ${rawPath}`,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.projectArtifacts.agentContent("agent-1", artifact.id), {
      ...artifact,
      contentType: "diff",
      content: [
        "--- /home/phoenix/private/old.ts",
        "+++ \\\\server\\share\\private.ts",
        "@@ -1 +1 @@ /home/phoenix/private",
        "-old",
        "+new",
      ].join("\n"),
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ArtifactsPane artifacts={[artifact]} agentId="agent-1" agentTitle="Agent" projectRoot="/srv/project" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Open Edit · secret.ts (secret.ts)" }).getAttribute("title")).toBe("secret.ts");
    expect(screen.getByLabelText("Unified diff").textContent).toContain("diff --git a/secret.ts b/secret.ts");
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.innerHTML).not.toContain("\\server");
    fireEvent.change(screen.getByRole("textbox", { name: "Search agent files and results" }), {
      target: { value: "phoenix/private" },
    });
    expect(screen.getByText("No files or results match “phoenix/private”.")).toBeTruthy();
  });

  it.each([
    ["rename-from", "rename from /home/phoenix/private/old.ts"],
    ["rename-to", "rename to C:\\Users\\patrick\\private.ts"],
    ["copy-from", "copy from \\\\server\\share\\private.ts"],
    ["copy-to", "copy to /home/phoenix/private/copied.ts"],
    ["binary", "Binary files /home/phoenix/private/old.bin and C:\\Users\\patrick\\private.bin differ"],
    ["context", "*** /home/phoenix/private/old.ts\t2026-08-14"],
  ])("fails a create-mode %s header closed in Agent ArtifactPreview", (_name, rawDiff) => {
    const rawPath = "/srv/project/src/public.ts";
    const artifact: ArtifactDto = {
      id: `artifact-create-${_name}`,
      agentId: "agent-1",
      kind: "diff",
      path: `artifacts/create-${_name}.diff`,
      sourcePath: rawPath,
      summary: `create ${rawPath}`,
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.projectArtifacts.agentContent("agent-1", artifact.id), {
      ...artifact,
      contentType: "diff",
      content: rawDiff,
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ArtifactsPane artifacts={[artifact]} agentId="agent-1" agentTitle="Agent" projectRoot="/srv/project" />
      </QueryClientProvider>,
    );

    expect(screen.queryByLabelText("Unified diff")).toBeNull();
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.textContent).not.toContain("C:\\Users");
    expect(container.innerHTML).not.toContain("server\\share");
  });

  it("keeps raw paths and arbitrary summaries out of visible, title, and ARIA output", () => {
    const rawPath = "/home/phoenix/private/report.pdf";
    const artifact: ArtifactDto = {
      id: "artifact-1",
      agentId: "agent-1",
      kind: "document",
      path: "artifacts/report.pdf",
      sourcePath: rawPath,
      summary: `generated result at ${rawPath}`,
      mediaType: "application/pdf",
      previewUrl: "/api/artifacts/artifact-1/preview",
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ArtifactsPane
          artifacts={[artifact]}
          agentId="agent-1"
          agentTitle="Agent"
          projectRoot="/srv/project"
        />
      </QueryClientProvider>,
    );

    const open = screen.getByRole("button", { name: "Open report.pdf (report.pdf)" });
    expect(open.getAttribute("title")).toBe("report.pdf");
    expect(container.textContent).not.toContain(rawPath);
    expect(container.innerHTML).not.toContain(rawPath);

    fireEvent.change(screen.getByRole("textbox", { name: "Search agent files and results" }), {
      target: { value: "phoenix/private" },
    });
    expect(screen.getByText("No files or results match “phoenix/private”.")).toBeTruthy();
  });

  it("neutralizes a contained control-character injection across list, search, ARIA, title, and preview", () => {
    const rawPath = "/srv/project/report.ts\n+++ /home/patrick/private/secret.pdf";
    const artifact: ArtifactDto = {
      id: "artifact-injection",
      agentId: "agent-1",
      kind: "document",
      path: "artifacts/secret.pdf",
      sourcePath: rawPath,
      summary: `generated result at ${rawPath}`,
      mediaType: "application/pdf",
      previewUrl: "/api/artifacts/artifact-injection/preview",
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ArtifactsPane
          artifacts={[artifact]}
          agentId="agent-1"
          agentTitle="Agent"
          projectRoot="/srv/project"
        />
      </QueryClientProvider>,
    );

    const open = screen.getByRole("button", { name: "Open secret.pdf (secret.pdf)" });
    expect(open.getAttribute("title")).toBe("secret.pdf");
    expect(screen.getByTestId("file-pdf-preview").getAttribute("title")).toBe("Preview secret.pdf");
    expect(container.textContent).not.toContain("/home/patrick");
    expect(container.innerHTML).not.toContain("/home/patrick");
    expect(container.innerHTML).not.toContain("+++");
    expect(container.innerHTML).not.toContain("\u202e");

    fireEvent.change(screen.getByRole("textbox", { name: "Search agent files and results" }), {
      target: { value: "patrick/private" },
    });
    expect(screen.getByText("No files or results match “patrick/private”.")).toBeTruthy();
  });

  it.each([
    ["backslash traversal", "/srv/project/..\\secret.pdf", "secret.pdf"],
    ["Windows-looking filename", "/srv/project/C:\\Users\\patrick\\private.pdf", "private.pdf"],
    ["UNC-looking filename", "/srv/project/\\\\server\\share\\private.pdf", "private.pdf"],
  ])("fails a contained POSIX %s closed across display, search, ARIA, title, and preview", (_name, rawPath, displayPath) => {
    const artifact: ArtifactDto = {
      id: "artifact-ambiguous",
      agentId: "agent-1",
      kind: "document",
      path: "artifacts/private.pdf",
      sourcePath: rawPath,
      summary: `generated result at ${rawPath}`,
      mediaType: "application/pdf",
      previewUrl: "/api/artifacts/artifact-ambiguous/preview",
      createdAt: "2026-08-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ArtifactsPane
          artifacts={[artifact]}
          agentId="agent-1"
          agentTitle="Agent"
          projectRoot="/srv/project"
        />
      </QueryClientProvider>,
    );

    const open = screen.getByRole("button", { name: `Open ${displayPath} (${displayPath})` });
    expect(open.getAttribute("title")).toBe(displayPath);
    expect(screen.getByTestId("file-pdf-preview").getAttribute("title")).toBe(`Preview ${displayPath}`);
    expect(container.textContent).not.toContain(rawPath);
    expect(container.innerHTML).not.toContain(rawPath);
    expect(container.innerHTML).not.toContain("\\");

    fireEvent.change(screen.getByRole("textbox", { name: "Search agent files and results" }), {
      target: { value: "srv/project" },
    });
    expect(screen.getByText("No files or results match “srv/project”.")).toBeTruthy();
  });
});
