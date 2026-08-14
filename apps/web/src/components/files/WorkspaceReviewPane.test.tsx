import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChangedFileDto, WorkspaceFileReviewDto, WorkspaceStatusDto } from "@ponderosa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../queryKeys";
import { WorkspaceReviewPane } from "./WorkspaceReviewPane";

afterEach(cleanup);

function changedFile(path: string, lastSeq = 7): ChangedFileDto {
  return {
    path,
    kind: "edit",
    lastSeq,
    lastChangedAt: "2026-08-14T00:00:00.000Z",
    executionCount: 1,
    diffAvailable: true,
  };
}

function renderReview({
  files,
  workspace,
  details,
  workspaceReview,
  onOpenInNewTab,
}: {
  files: ChangedFileDto[];
  workspace: WorkspaceStatusDto;
  details?: Array<ChangedFileDto & { diff?: string; executionIds: string[]; provenanceTruncated: boolean }>;
  workspaceReview?: WorkspaceFileReviewDto;
  onOpenInNewTab?: (path: string) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.workspaceChanges.project("project-1"), workspace);
  if (workspaceReview) {
    queryClient.setQueryData(
      queryKeys.workspaceFile.detail("project-1", workspaceReview.path),
      workspaceReview,
    );
  }
  for (const detail of details ?? []) {
    queryClient.setQueryData(
      queryKeys.workspaceChanges.file("agent-1", detail.path, detail.lastSeq),
      detail,
    );
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceReviewPane
        projectId="project-1"
        projectRoot="/srv/project"
        agentId="agent-1"
        files={files}
        running={false}
        onBack={() => undefined}
        onOpenInNewTab={onOpenInNewTab}
      />
    </QueryClientProvider>,
  );
}

describe("WorkspaceReviewPane path presentation", () => {
  it.each([
    ["POSIX contained", "/srv/project/src/index.ts", "src/index.ts"],
    ["Windows-looking", "/srv/project/C:\\Users\\patrick\\secret.ts", "secret.ts"],
    ["UNC-looking", "/srv/project/\\\\server\\share\\secret.ts", "secret.ts"],
    ["separator traversal", "/srv/project/..\\secret.ts", "secret.ts"],
    ["control", "/srv/project/report.ts\n+++ /home/phoenix/private/control.ts", "control.ts"],
    ["bidi", "/srv/project/private/report\u202esecret.ts", "report�secret.ts"],
  ])("sanitizes %s visible, title, and ARIA labels", (_name, rawPath, presentedPath) => {
    const file = changedFile(rawPath);
    const { container } = renderReview({
      files: [file],
      workspace: {
        projectId: "project-1",
        isGitRepository: false,
        generatedAt: "2026-08-14T00:00:00.000Z",
        changes: [],
      },
    });

    const reviewButton = screen.getByRole("button", { name: `Review ${presentedPath}` });
    expect(reviewButton.getAttribute("title")).toBe(presentedPath);
    expect(container.textContent).toContain(presentedPath);
    expect(container.textContent).not.toContain(rawPath);
    expect(container.innerHTML).not.toContain(rawPath);
  });

  it("reconstructs recorded diff headers and preserves exact raw navigation across display collisions", () => {
    const firstPath = "/home/phoenix/one/secret.ts";
    const secondPath = "/private/two/secret.ts";
    const files = [changedFile(firstPath, 7), changedFile(secondPath, 8)];
    const rawDiff = [
      "--- /home/phoenix/private/old.ts",
      "+++ C:\\Users\\patrick\\private.ts",
      "@@ -1 +1 @@ /home/phoenix/private",
      "-old",
      "+new",
    ].join("\n");
    const onOpenInNewTab = vi.fn();
    const { container } = renderReview({
      files,
      workspace: {
        projectId: "project-1",
        isGitRepository: false,
        generatedAt: "2026-08-14T00:00:00.000Z",
        changes: [],
      },
      details: files.map(file => ({
        ...file,
        executionIds: ["execution-1"],
        provenanceTruncated: false,
        diff: rawDiff,
      })),
      onOpenInNewTab,
    });

    expect(screen.getByLabelText("Unified diff").textContent).toContain("diff --git a/secret.ts b/secret.ts");
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.textContent).not.toContain("C:\\Users");
    const colliding = screen.getAllByRole("button", { name: "Review secret.ts" });
    expect(colliding).toHaveLength(2);
    fireEvent.click(colliding[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Open in New Tab" }));
    expect(onOpenInNewTab).toHaveBeenCalledWith(secondPath);
  });

  it.each([
    ["rename-from", "rename from /home/phoenix/private/old.ts"],
    ["rename-to", "rename to C:\\Users\\patrick\\private.ts"],
    ["copy-from", "copy from \\\\server\\share\\private.ts"],
    ["copy-to", "copy to /home/phoenix/private/copied.ts"],
    ["binary", "Binary files /home/phoenix/private/old.bin and \\\\server\\share\\private.bin differ"],
    ["context", "*** /home/phoenix/private/old.ts\t2026-08-14"],
  ])("fails a create-mode %s header closed in recorded non-Git Review", (_name, rawDiff) => {
    const rawPath = "/srv/project/src/public.ts";
    const file = { ...changedFile(rawPath), kind: "create" as const };
    const { container } = renderReview({
      files: [file],
      workspace: {
        projectId: "project-1",
        isGitRepository: false,
        generatedAt: "2026-08-14T00:00:00.000Z",
        changes: [],
      },
      details: [{
        ...file,
        executionIds: ["execution-1"],
        provenanceTruncated: false,
        diff: rawDiff,
      }],
    });

    expect(screen.queryByLabelText("Unified diff")).toBeNull();
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.textContent).not.toContain("C:\\Users");
    expect(container.innerHTML).not.toContain("server\\share");
  });

  it("reconstructs Git review headers while retaining the exact lookup and navigation path", () => {
    const rawPath = "/srv/project/..\\secret.ts";
    const rawDiff = [
      "diff --git a//home/phoenix/private.ts b//home/phoenix/private.ts",
      "--- /home/phoenix/private.ts",
      "+++ \\\\server\\share\\private.ts",
      "@@ -1 +1 @@ /home/phoenix/private",
      "-old",
      "+new",
    ].join("\n");
    const onOpenInNewTab = vi.fn();
    const { container } = renderReview({
      files: [],
      workspace: {
        projectId: "project-1",
        isGitRepository: true,
        generatedAt: "2026-08-14T00:00:00.000Z",
        changes: [{
          path: rawPath,
          kind: "edit",
          staged: false,
          unstaged: true,
          untracked: false,
        }],
      },
      workspaceReview: {
        projectId: "project-1",
        path: rawPath,
        exists: true,
        diff: rawDiff,
        stagedDiff: "",
        unstagedDiff: rawDiff,
        truncated: false,
      },
      onOpenInNewTab,
    });

    const reviewButton = screen.getByRole("button", { name: "Review secret.ts" });
    expect(reviewButton.getAttribute("title")).toBe("secret.ts");
    expect(reviewButton.getAttribute("data-workspace-path")).toBe("secret.ts");
    expect(screen.getByLabelText("Unified diff").textContent).toContain("diff --git a/secret.ts b/secret.ts");
    expect(container.textContent).not.toContain("/home/phoenix");
    expect(container.innerHTML).not.toContain(rawPath);
    fireEvent.click(screen.getByRole("button", { name: "Open in New Tab" }));
    expect(onOpenInNewTab).toHaveBeenCalledWith(rawPath);
  });
});
