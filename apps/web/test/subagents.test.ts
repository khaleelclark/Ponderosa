import { describe, expect, it } from "vitest";
import {
  applySubagentEvent,
  applyCancellationResult,
  buildSubagentTree,
  emptySubagentStore,
  isSubagentUiEnabled,
  subagentTranscript,
  type SubagentRunView,
} from "../src/subagents";

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id,
  rootRunId: "root",
  depth: 0,
  displayLabel: id,
  delegationSummary: `Do ${id}`,
  status: "queued",
  createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
  updatedAt: `2026-01-01T00:00:0${id.length}.000Z`,
  version: 1,
  cancellable: true,
  ...overrides,
});

describe("subagent UI adapter", () => {
  it("keeps the Collaboration mount behind an explicit feature flag", () => {
    expect(isSubagentUiEnabled({})).toBe(false);
    expect(isSubagentUiEnabled({ PUBLIC_PONDEROSA_SUBAGENTS: "true" })).toBe(true);
    expect(isSubagentUiEnabled({ VITE_PONDEROSA_SUBAGENTS: "1" })).toBe(true);
    expect(isSubagentUiEnabled({ PUBLIC_PONDEROSA_SUBAGENTS: "false" })).toBe(false);
  });

  it("upserts lifecycle events and ignores replayed or stale changes", () => {
    let store = emptySubagentStore();
    store = applySubagentEvent(store, { seq: 1, type: "upsert", run: run("parent") });
    store = applySubagentEvent(store, {
      seq: 2,
      type: "upsert",
      run: run("parent", { version: 2, status: "running" }),
    });
    const current = store;
    store = applySubagentEvent(store, {
      seq: 2,
      type: "upsert",
      run: run("parent", { version: 3, status: "failed" }),
    });
    expect(store).toBe(current);
    store = applySubagentEvent(store, {
      seq: 3,
      type: "upsert",
      run: run("parent", { version: 1, status: "failed" }),
    });
    expect(store.runs.get("parent")?.status).toBe("running");
    expect(store.lastSeq).toBe(3);
  });

  it("deduplicates and orders transcript chunks by the per-run cursor", () => {
    let store = emptySubagentStore();
    store = applySubagentEvent(store, { seq: 1, type: "output", chunk: { runId: "run", chunkSeq: 2, cursor: "b", text: "world" } });
    store = applySubagentEvent(store, { seq: 2, type: "output", chunk: { runId: "run", chunkSeq: 1, cursor: "a", text: "hello " } });
    store = applySubagentEvent(store, { seq: 3, type: "output", chunk: { runId: "run", chunkSeq: 2, cursor: "b", text: "duplicate" } });
    expect(subagentTranscript(store, "run")).toBe("hello world");
  });

  it("applies cancellation only after a server-confirmed result", () => {
    let store = applySubagentEvent(emptySubagentStore(), {
      seq: 1,
      type: "upsert",
      run: run("parent", { status: "running", version: 2 }),
    });
    store = applyCancellationResult(store, {
      affected: [{ runId: "parent", status: "cancelled", version: 3, updatedAt: "2026-01-02T00:00:00.000Z" }],
    });
    expect(store.runs.get("parent")).toMatchObject({ status: "cancelled", version: 3, cancellable: false });
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
