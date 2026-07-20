import type { AgentDetailDto, ChangedFileDetailDto, SseEventEnvelope } from "@ponderosa/core";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ChangedFilesPane, WorkspaceReviewPane } from "../src/components/panes";
import { useAgentStream } from "../src/hooks/useAgentStream";

afterEach(() => vi.restoreAllMocks());

function LiveChangedFileViews({ agentId }: { agentId: string }): JSX.Element {
  useAgentStream(agentId);
  const detail = useQuery({
    queryKey: ["agent", agentId, 100],
    queryFn: () => api.getAgent(agentId, 100),
    staleTime: Infinity,
  });
  const files = detail.data?.changedFiles ?? [];
  return <>
    <ChangedFilesPane agentId={agentId} files={files} />
    <WorkspaceReviewPane
      projectId="project"
      agentId={agentId}
      files={files}
      running={false}
      initialPath="src/live.ts"
    />
  </>;
}

function renderedText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (value && typeof value === "object" && "children" in value) {
    return renderedText((value as { children?: unknown }).children);
  }
  return "";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const firstChangedAt = "2026-07-20T09:00:00.000Z";
const secondChangedAt = "2026-07-20T09:01:00.000Z";
const thirdChangedAt = "2026-07-20T09:02:00.000Z";

function liveDetail(agentId: string): AgentDetailDto {
  return {
    agent: { id: agentId, projectId: "project", activeEngine: "codex" },
    messages: [],
    runOutput: [],
    activity: [],
    changedFiles: [{
      path: "src/live.ts", kind: "edit", lastSeq: 1, lastChangedAt: firstChangedAt,
      executionCount: 1, diffAvailable: true,
    }],
    runs: [{
      id: "run-2", agentId, status: "running", engine: "codex", title: "Second Run",
      startedAt: secondChangedAt, updatedAt: secondChangedAt,
    }],
    workItems: [],
    artifacts: [],
  } as unknown as AgentDetailDto;
}

function firstDetail(detail: AgentDetailDto): ChangedFileDetailDto {
  return {
    ...detail.changedFiles[0]!, executionIds: ["run-1"], provenanceTruncated: false,
    diff: "--- a/src/live.ts\n+++ b/src/live.ts\n-old\n+first",
  };
}

const secondDetail: ChangedFileDetailDto = {
  path: "src/live.ts", kind: "edit", lastSeq: 2, lastChangedAt: secondChangedAt,
  executionCount: 2, diffAvailable: true, executionIds: ["run-2", "run-1"], provenanceTruncated: false,
  diff: "--- a/src/live.ts\n+++ b/src/live.ts\n-first\n+second",
};

async function mountLiveViews(agentId: string, nextDetail: Promise<ChangedFileDetailDto>): Promise<{
  client: QueryClient;
  emit: (envelope: SseEventEnvelope) => void;
  getChangedFileDetail: ReturnType<typeof vi.spyOn>;
  view: ReturnType<typeof create>;
}> {
  const detail = liveDetail(agentId);
  let emit!: (envelope: SseEventEnvelope) => void;
  vi.spyOn(api, "subscribeAgent").mockImplementation((_id, _cursor, handlers) => {
    emit = handlers.onEvent;
    return { close: vi.fn() };
  });
  vi.spyOn(api, "getAgent").mockResolvedValue(detail);
  vi.spyOn(api, "getWorkspaceStatus").mockResolvedValue({
    projectId: "project",
    isGitRepository: true,
    branch: "feature/live",
    head: "abc1234",
    generatedAt: secondChangedAt,
    changes: [{ path: "src/live.ts", kind: "edit", staged: false, unstaged: true, untracked: false }],
  });
  vi.spyOn(api, "getWorkspaceFile").mockResolvedValue({
    projectId: "project",
    path: "src/live.ts",
    exists: true,
    content: "export const live = true;\n",
    diff: "@@ -1 +1 @@\n-false\n+true",
    stagedDiff: "",
    unstagedDiff: "@@ -1 +1 @@\n-false\n+true",
    truncated: false,
  });
  const getChangedFileDetail = vi.spyOn(api, "getChangedFileDetail").mockImplementation(() => nextDetail);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["agent", agentId, 100], detail);
  client.setQueryData(["changed-file", agentId, "src/live.ts", 1], firstDetail(detail));

  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<QueryClientProvider client={client}><LiveChangedFileViews agentId={agentId} /></QueryClientProvider>);
  });
  await act(async () => {
    emit({ seq: 1, ts: firstChangedAt, replayed: true, event: { type: "session", sessionId: "session-1" } });
  });
  await act(async () => {
    view.root.findByProps({ "aria-expanded": false }).props.onClick();
  });
  await vi.waitFor(() => expect(renderedText(view.toJSON())).toContain("+first"));
  return { client, emit, getChangedFileDetail, view };
}

function runBFileChange(seq = 2, ts = secondChangedAt): SseEventEnvelope {
  return {
    seq,
    ts,
    event: {
      type: "file_change",
      path: "src/live.ts",
      kind: "edit",
      diff: `--- a/src/live.ts\n+++ b/src/live.ts\n-before\n+after-${seq}`,
    },
  };
}

function expectImmediateRunB(view: ReturnType<typeof create>): void {
  const text = renderedText(view.toJSON());
  expect(text).toContain("2 runs");
  expect(text).toContain("2 agent runs");
  expect(text).not.toContain("1 run");
  expect(text).not.toContain("1 agent run");
  expect(text).not.toContain("+first");
}

function dispose(view: ReturnType<typeof create>, client: QueryClient): void {
  view.unmount();
  client.clear();
}

describe("live Changed Files detail", () => {
  it("reveals the same durable recorded diff inline from the file path and Open Current Diff action", async () => {
    const recorded = {
      path: "src/live.ts", kind: "edit", lastSeq: 2, lastChangedAt: secondChangedAt,
      executionCount: 2, diffAvailable: true, executionIds: ["run-2"], provenanceTruncated: false,
      diff: "--- a/src/live.ts\n+++ b/src/live.ts\n-before\n+durable-recorded",
    } satisfies ChangedFileDetailDto;
    const getChangedFileDetail = vi.spyOn(api, "getChangedFileDetail").mockResolvedValue(recorded);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ChangedFilesPane
        agentId="agent-review"
        files={[{
          path: "src/live.ts", kind: "edit", lastSeq: 2, lastChangedAt: secondChangedAt,
          executionCount: 2, diffAvailable: true,
        }]}
      /></QueryClientProvider>);
    });

    act(() => view.root.findByProps({ "aria-label": "Open recorded diff for src/live.ts" }).props.onClick());
    await vi.waitFor(() => expect(renderedText(view.toJSON())).toContain("+durable-recorded"));

    act(() => view.root.findByProps({ "aria-label": "Hide recorded diff for src/live.ts" }).props.onClick());
    expect(renderedText(view.toJSON())).not.toContain("+durable-recorded");
    const openAction = view.root.findAll((node) => node.type === "button" && renderedText(node.props.children) === "Open Current Diff")[0];
    act(() => openAction!.props.onClick());
    await vi.waitFor(() => expect(renderedText(view.toJSON())).toContain("+durable-recorded"));
    expect(getChangedFileDetail).toHaveBeenCalledWith("agent-review", "src/live.ts");
    dispose(view, client);
  });

  it("explains missing historical diffs without consulting the current working tree", async () => {
    const getChangedFileDetail = vi.spyOn(api, "getChangedFileDetail");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><ChangedFilesPane agentId="agent-no-diff" files={[{
        path: "image.bin", kind: "create", lastSeq: 1, lastChangedAt: firstChangedAt,
        executionCount: 1, diffAvailable: false,
      }]} /></QueryClientProvider>);
    });
    act(() => view.root.findByProps({ "aria-label": "Open recorded diff for image.bin" }).props.onClick());
    expect(renderedText(view.toJSON())).toContain("durable recorded diff is unavailable");
    expect(renderedText(view.toJSON())).toContain("Current working-tree state is separate");
    expect(getChangedFileDetail).not.toHaveBeenCalled();
    dispose(view, client);
  });

  it("immediately advances expanded Changed Files and Review while Run B detail is deferred", async () => {
    const pending = deferred<ChangedFileDetailDto>();
    const mounted = await mountLiveViews("agent-live-deferred", pending.promise);

    await act(async () => mounted.emit(runBFileChange()));
    await vi.waitFor(() => expectImmediateRunB(mounted.view));

    expect(mounted.getChangedFileDetail).toHaveBeenCalledTimes(1);
    expect(mounted.client.getQueryData<AgentDetailDto>(["agent", "agent-live-deferred", 100])?.changedFiles[0])
      .toMatchObject({ lastSeq: 2, executionCount: 2 });
    dispose(mounted.view, mounted.client);
  });

  it("keeps the new live count and suppresses the stale diff when Run B detail is rejected", async () => {
    const pending = deferred<ChangedFileDetailDto>();
    const mounted = await mountLiveViews("agent-live-rejected", pending.promise);

    await act(async () => mounted.emit(runBFileChange()));
    await act(async () => pending.reject(new Error("detail unavailable")));
    await vi.waitFor(() => {
      expectImmediateRunB(mounted.view);
      expect(renderedText(mounted.view.toJSON())).toContain("durable recorded diff could not be loaded");
    });

    dispose(mounted.view, mounted.client);
  });

  it("does not double-count duplicate same-Run file events", async () => {
    const pending = deferred<ChangedFileDetailDto>();
    const mounted = await mountLiveViews("agent-live-duplicate", pending.promise);

    await act(async () => mounted.emit(runBFileChange()));
    await act(async () => mounted.emit(runBFileChange(3, thirdChangedAt)));
    await vi.waitFor(() => expectImmediateRunB(mounted.view));

    expect(mounted.client.getQueryData<AgentDetailDto>(["agent", "agent-live-duplicate", 100])?.changedFiles[0])
      .toMatchObject({ lastSeq: 3, executionCount: 2 });
    dispose(mounted.view, mounted.client);
  });

  it("reconciles the immutable Run B detail without regressing either live count", async () => {
    const pending = deferred<ChangedFileDetailDto>();
    const mounted = await mountLiveViews("agent-live-success", pending.promise);

    await act(async () => mounted.emit(runBFileChange()));
    await vi.waitFor(() => expectImmediateRunB(mounted.view));
    await act(async () => pending.resolve(secondDetail));
    await vi.waitFor(() => {
      expectImmediateRunB(mounted.view);
      expect(renderedText(mounted.view.toJSON())).toContain("+second");
    });

    expect(mounted.client.getQueryData<ChangedFileDetailDto>(["changed-file", "agent-live-success", "src/live.ts", 2]))
      .toEqual(secondDetail);
    dispose(mounted.view, mounted.client);
  });
});
