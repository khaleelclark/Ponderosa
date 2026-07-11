import { describe, expect, it } from "vitest";
import {
  applySubagentEvent,
  buildSubagentTree,
  emptySubagentStore,
  subagentTranscript,
  type SubagentRunView,
} from "../src/subagents";

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id,
  rootRunId: "root",
  depth: 0,
  title: id,
  prompt: `Do ${id}`,
  status: "queued",
  createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
  version: 1,
  cancellable: true,
  ...overrides,
});

describe("subagent UI adapter", () => {
  it("upserts lifecycle events and ignores replayed or stale changes", () => {
    let store = emptySubagentStore();
    store = applySubagentEvent(store, { seq: 1, type: "upsert", run: run("parent") });
    store = applySubagentEvent(store, {
      seq: 2,
      type: "patch",
      runId: "parent",
      version: 2,
      patch: { status: "running" },
    });
    const current = store;
    store = applySubagentEvent(store, {
      seq: 2,
      type: "patch",
      runId: "parent",
      version: 3,
      patch: { status: "failed" },
    });
    expect(store).toBe(current);
    store = applySubagentEvent(store, {
      seq: 3,
      type: "patch",
      runId: "parent",
      version: 1,
      patch: { status: "failed" },
    });
    expect(store.runs.get("parent")?.status).toBe("running");
    expect(store.lastSeq).toBe(3);
  });

  it("deduplicates and orders transcript chunks by the per-run cursor", () => {
    let store = emptySubagentStore();
    store = applySubagentEvent(store, { seq: 1, type: "output", chunk: { runId: "run", cursor: 2, text: "world" } });
    store = applySubagentEvent(store, { seq: 2, type: "output", chunk: { runId: "run", cursor: 1, text: "hello " } });
    store = applySubagentEvent(store, { seq: 3, type: "output", chunk: { runId: "run", cursor: 2, text: "duplicate" } });
    expect(subagentTranscript(store, "run")).toBe("hello world");
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
