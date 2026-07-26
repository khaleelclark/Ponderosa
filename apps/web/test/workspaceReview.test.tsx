// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceReviewPane } from "../src/components/files/WorkspaceReviewPane";

describe("workspace review", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders Git truth with stable automation hooks and agent provenance", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("/workspace/file")
        ? { projectId: "project", path: "src/app.ts", exists: true, content: "export {};\n", diff: "@@ -0,0 +1 @@\n+export {};", stagedDiff: "", unstagedDiff: "@@ -0,0 +1 @@\n+export {};", truncated: false }
        : { projectId: "project", isGitRepository: true, branch: "feature/review", head: "abc1234", generatedAt: new Date().toISOString(), changes: [{ path: "src/app.ts", kind: "edit", staged: false, unstaged: true, untracked: false }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><WorkspaceReviewPane
        projectId="project"
        running={false}
        files={[{ path: "src/app.ts", kind: "edit", lastSeq: 3, lastChangedAt: new Date().toISOString(), executionCount: 1, diffAvailable: false }]}
      /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(view.root.findByProps({ "data-testid": "workspace-review" })).toBeTruthy();
    expect(view.root.findByProps({ "data-workspace-path": "src/app.ts" })).toBeTruthy();
    expect(view.root.findAllByProps({ "data-testid": "workspace-diff" }).length).toBeGreaterThan(0);
    expect(JSON.stringify(view.toJSON())).toContain("this agent");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/workspace/file") && String(input).includes("src%2Fapp.ts"))).toBe(true);
    view.unmount();
    client.clear();
  });
});
