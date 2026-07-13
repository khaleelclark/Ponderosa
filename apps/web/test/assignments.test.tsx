import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssignmentEventEnvelope, AssignmentDto } from "@ponderosa/core";
import {
  applyAssignmentEnvelope,
  applyCancellationResult,
  buildAssignmentTree,
  emptyAssignmentStore,
  hydrateAssignmentStore,
  isAssignmentUiEnabled,
  assignmentRootsByParentThread,
} from "../src/assignments";
import { AssignmentTreePanel } from "../src/components/AssignmentTreePanel";

const run = (id: string, overrides: Partial<AssignmentDto> = {}): AssignmentDto => ({
  id,
  projectId: "project",
  masterChatId: "master",
  parentAgentId: "manager",
  childAgentId: `agent-${id}`,
  parentExecutionId: "parent-execution",
  childExecutionId: `execution-${id}`,
  rootAssignmentId: id,
  depth: 0,
  title: id,
  taskBriefMarkdown: `## ${id}\n\nDo the work exactly.`,
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
  event: AssignmentEventEnvelope["event"],
): AssignmentEventEnvelope => ({ masterChatId: "master", seq, ts: "2026-01-01T00:00:00.000Z", event });

describe("assignment UI adapter", () => {
  it("shows delegated agents by default with an explicit kill switch", () => {
    expect(isAssignmentUiEnabled({})).toBe(true);
    expect(isAssignmentUiEnabled({ PUBLIC_PONDEROSA_ASSIGNMENTS: "true" })).toBe(true);
    expect(isAssignmentUiEnabled({ VITE_PONDEROSA_ASSIGNMENTS: "1" })).toBe(true);
    expect(isAssignmentUiEnabled({ PUBLIC_PONDEROSA_ASSIGNMENTS: "false" })).toBe(false);
    expect(isAssignmentUiEnabled({ PUBLIC_PONDEROSA_ASSIGNMENTS: "0" })).toBe(false);
  });

  it("resumes from the reconnect cursor and ignores replayed or stale changes", () => {
    let store = emptyAssignmentStore();
    store = applyAssignmentEnvelope(store, envelope(1, { type: "assignment_created", assignment: run("parent") }));
    store = applyAssignmentEnvelope(store, envelope(2, {
      type: "assignment_updated",
      assignment: run("parent", { version: 2, status: "running" }),
    }));
    const current = store;
    store = applyAssignmentEnvelope(store, envelope(2, {
      type: "assignment_updated",
      assignment: run("parent", { version: 3, status: "failed" }),
    }));
    expect(store).toBe(current);
    store = applyAssignmentEnvelope(store, envelope(3, {
      type: "assignment_updated",
      assignment: run("parent", { version: 1, status: "failed" }),
    }));
    expect(store.assignments.get("parent")?.status).toBe("running");
    expect(store.lastSeq).toBe(3);
  });

  it("groups delegated lineage beneath its server-derived parent agent", () => {
    const parent = run("child", { parentAgentId: "agent-1", depth: 1 });
    const nested = run("nested", {
      parentAgentId: "agent-1",
      parentAssignmentId: "child",
      depth: 2,
    });
    const grouped = assignmentRootsByParentThread([parent, nested]);
    expect(grouped.get("agent-1")?.map((item) => item.id)).toEqual(["child"]);
    expect(grouped.get("agent-1")?.[0]?.children.map((item) => item.id)).toEqual(["nested"]);
  });

  it("applies cancellation only after a server-confirmed result", () => {
    let store = applyAssignmentEnvelope(emptyAssignmentStore(), envelope(1, {
      type: "assignment_created",
      assignment: run("parent", { status: "running", version: 2 }),
    }));
    store = applyCancellationResult(store, {
      requestedAssignmentId: "parent",
      scope: "branch",
      affected: [{ assignmentId: "parent", status: "cancelled", version: 3, updatedAt: "2026-01-02T00:00:00.000Z" }],
      completed: true,
    });
    expect(store.assignments.get("parent")).toMatchObject({ status: "cancelled", version: 3, canCancel: false });
  });

  it("derives stable parent-child trees and keeps orphans visible", () => {
    const tree = buildAssignmentTree([
      run("child", { parentAssignmentId: "parent", depth: 1 }),
      run("orphan", { parentAssignmentId: "missing", depth: 2 }),
      run("parent"),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["orphan", "parent"]);
    expect(tree[1]?.children.map((node) => node.id)).toEqual(["child"]);
  });

  it("renders the exact Markdown brief and canonical assignment state", () => {
    const assignment = run("markdown", { status: "running", taskBriefMarkdown: "# Exact brief\n\n- preserve `code`" });
    const html = renderToStaticMarkup(<AssignmentTreePanel store={hydrateAssignmentStore([assignment])} onCancel={() => {}} onOpenAgent={() => {}} />);
    expect(html).toContain("# Exact brief");
    expect(html).toContain("preserve `code`");
    expect(html).toContain("Assignments (1)");
  });
});
