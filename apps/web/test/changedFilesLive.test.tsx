import type { AgentDetailDto, ChangedFileDetailDto, SseEventEnvelope } from "@ponderosa/core";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ChangedFilesPane } from "../src/components/panes";
import { useAgentStream } from "../src/hooks/useAgentStream";

afterEach(() => vi.restoreAllMocks());

function LiveChangedFiles({ agentId }: { agentId: string }): JSX.Element {
  useAgentStream(agentId);
  const detail = useQuery({
    queryKey: ["agent", agentId, 100],
    queryFn: () => api.getAgent(agentId, 100),
    staleTime: Infinity,
  });
  return <ChangedFilesPane agentId={agentId} files={detail.data?.changedFiles ?? []} />;
}

function renderedText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (value && typeof value === "object" && "children" in value) {
    return renderedText((value as { children?: unknown }).children);
  }
  return "";
}

describe("live Changed Files detail", () => {
  it("keeps an expanded path on the current canonical diff and provenance after another Run changes it", async () => {
    const agentId = "agent-live-changed-file";
    const firstChangedAt = "2026-07-20T09:00:00.000Z";
    const secondChangedAt = "2026-07-20T09:01:00.000Z";
    const detail = {
      agent: { id: agentId, projectId: "project", activeEngine: "codex" },
      messages: [],
      runOutput: [],
      activity: [],
      changedFiles: [{
        path: "src/live.ts", kind: "edit", lastSeq: 1, lastChangedAt: firstChangedAt,
        executionCount: 1, diffAvailable: true,
      }],
      runs: [{ id: "run-2", agentId, status: "running", engine: "codex", title: "Second Run", startedAt: secondChangedAt, updatedAt: secondChangedAt }],
      workItems: [],
      artifacts: [],
    } as unknown as AgentDetailDto;
    const first: ChangedFileDetailDto = {
      ...detail.changedFiles[0]!, executionIds: ["run-1"], provenanceTruncated: false,
      diff: "--- a/src/live.ts\n+++ b/src/live.ts\n-old\n+first",
    };
    const second: ChangedFileDetailDto = {
      path: "src/live.ts", kind: "edit", lastSeq: 2, lastChangedAt: secondChangedAt,
      executionCount: 2, diffAvailable: true, executionIds: ["run-2", "run-1"], provenanceTruncated: false,
      diff: "--- a/src/live.ts\n+++ b/src/live.ts\n-first\n+second",
    };
    let emit!: (envelope: SseEventEnvelope) => void;
    vi.spyOn(api, "subscribeAgent").mockImplementation((_id, _cursor, handlers) => {
      emit = handlers.onEvent;
      return { close: vi.fn() };
    });
    vi.spyOn(api, "getAgent").mockResolvedValue(detail);
    const getChangedFileDetail = vi.spyOn(api, "getChangedFileDetail")
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["agent", agentId, 100], detail);

    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><LiveChangedFiles agentId={agentId} /></QueryClientProvider>);
    });
    await act(async () => {
      emit({
        seq: 1,
        ts: firstChangedAt,
        replayed: true,
        event: { type: "file_change", path: "src/live.ts", kind: "edit", diff: first.diff },
      });
    });
    await act(async () => {
      view.root.findByProps({ "aria-expanded": false }).props.onClick();
    });
    await vi.waitFor(() => {
      expect(JSON.stringify(view.toJSON())).toContain("first");
    });

    await act(async () => {
      emit({
        seq: 2,
        ts: secondChangedAt,
        event: { type: "file_change", path: "src/live.ts", kind: "edit", diff: second.diff },
      });
    });
    await vi.waitFor(() => {
      const rendered = renderedText(view.toJSON());
      expect(rendered).toContain("second");
      expect(rendered).not.toContain("+first");
      expect(rendered).toContain("2 runs");
    });

    expect(getChangedFileDetail).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<ChangedFileDetailDto>(["changed-file", agentId, "src/live.ts", 2])).toEqual(second);
    view.unmount();
    client.clear();
  });
});
