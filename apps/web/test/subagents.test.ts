import { describe, expect, it } from "vitest";
import type { SubagentEventEnvelope, SubagentRunDto } from "@ponderosa/core";
import {
  applySubagentEnvelope,
  applyCancellationResult,
  buildSubagentTree,
  emptySubagentStore,
  isSubagentUiEnabled,
  subagentRootsByParentThread,
} from "../src/subagents";

const run = (id: string, overrides: Partial<SubagentRunDto> = {}): SubagentRunDto => ({
  id,
  masterChatId: "master",
  rootRunId: "root",
  parentRunId: "root",
  contextSnapshotId: "snapshot",
  depth: 0,
  displayLabel: id,
  delegationSummary: id,
  runtime: "codex",
  status: "queued",
  createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
  updatedAt: `2026-01-01T00:00:0${id.length}.000Z`,
  version: 1,
  canCancel: true,
  ...overrides,
});

const envelope = (
  seq: number,
  event: SubagentEventEnvelope["event"],
): SubagentEventEnvelope => ({ masterChatId: "master", seq, ts: "2026-01-01T00:00:00.000Z", event });

describe("subagent UI adapter", () => {
  it("shows delegated agents by default with an explicit kill switch", () => {
    expect(isSubagentUiEnabled({})).toBe(true);
    expect(isSubagentUiEnabled({ PUBLIC_PONDEROSA_SUBAGENTS: "true" })).toBe(true);
    expect(isSubagentUiEnabled({ VITE_PONDEROSA_SUBAGENTS: "1" })).toBe(true);
    expect(isSubagentUiEnabled({ PUBLIC_PONDEROSA_SUBAGENTS: "false" })).toBe(false);
    expect(isSubagentUiEnabled({ PUBLIC_PONDEROSA_SUBAGENTS: "0" })).toBe(false);
  });

  it("resumes from the reconnect cursor and ignores replayed or stale changes", () => {
    let store = emptySubagentStore();
    store = applySubagentEnvelope(store, envelope(1, { type: "subagent_spawned", run: run("parent") }));
    store = applySubagentEnvelope(store, envelope(2, {
      type: "subagent_updated",
      run: run("parent", { version: 2, status: "running" }),
    }));
    const current = store;
    store = applySubagentEnvelope(store, envelope(2, {
      type: "subagent_updated",
      run: run("parent", { version: 3, status: "failed" }),
    }));
    expect(store).toBe(current);
    store = applySubagentEnvelope(store, envelope(3, {
      type: "subagent_updated",
      run: run("parent", { version: 1, status: "failed" }),
    }));
    expect(store.runs.get("parent")?.status).toBe("running");
    expect(store.lastSeq).toBe(3);
  });

  it("groups delegated lineage beneath its server-derived parent agent", () => {
    const parent = run("child", { parentThreadId: "agent-1", depth: 1 });
    const nested = run("nested", {
      parentThreadId: "agent-1",
      parentRunId: "child",
      depth: 2,
    });
    const grouped = subagentRootsByParentThread([parent, nested]);
    expect(grouped.get("agent-1")?.map((item) => item.id)).toEqual(["child"]);
    expect(grouped.get("agent-1")?.[0]?.children.map((item) => item.id)).toEqual(["nested"]);
  });

  it("applies cancellation only after a server-confirmed result", () => {
    let store = applySubagentEnvelope(emptySubagentStore(), envelope(1, {
      type: "subagent_spawned",
      run: run("parent", { status: "running", version: 2 }),
    }));
    store = applyCancellationResult(store, {
      requestedRunId: "parent",
      scope: "branch",
      affected: [{ runId: "parent", status: "cancelled", version: 3, updatedAt: "2026-01-02T00:00:00.000Z" }],
      completed: true,
    });
    expect(store.runs.get("parent")).toMatchObject({ status: "cancelled", version: 3, canCancel: false });
  });

  it("derives stable parent-child trees and keeps orphans visible", () => {
    const tree = buildSubagentTree([
      run("child", { parentRunId: "parent", depth: 1 }),
      run("orphan", { parentRunId: "missing", depth: 2 }),
      run("parent"),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["orphan", "parent"]);
    expect(tree[1]?.children.map((node) => node.id)).toEqual(["child"]);
  });
});
