import assert from "node:assert/strict";
import { phaseQueryMatchesProject } from "../src/workspaceDirectoryScope.js";
import test from "node:test";
import {
  projectScopedWorkspaceDirectoryItems,
  sameWorkspaceDirectoryScope,
} from "../src/workspaceDirectoryScope.js";
import { queryKeys } from "../src/queryKeys.js";

const key = (kind, search, projectId, sort = "last_used", active) =>
  queryKeys.workspaceDirectory.list(
    kind,
    search,
    projectId,
    undefined,
    undefined,
    sort,
    active,
    undefined,
  );

test("phase refresh includes global queries but excludes unrelated Projects", () => {
  assert.equal(phaseQueryMatchesProject(key("agent", "", "a"), "a"), true);
  assert.equal(phaseQueryMatchesProject(key("agent", "", "b"), "a"), false);
  assert.equal(phaseQueryMatchesProject(key("agent", "", undefined), "a"), true);
  assert.equal(phaseQueryMatchesProject(["agent-health", "b"], "a"), false);
  assert.equal(phaseQueryMatchesProject(["agent-organization", "a"], "a"), true);
  assert.equal(phaseQueryMatchesProject(key("agent", "", "b")), true);
  const summary=[...key("agent", "", "a")]; summary[10]="summary";
  assert.equal(sameWorkspaceDirectoryScope(summary,key("agent", "", "a")),false);
});

test("directory placeholders never cross Project ownership", () => {
  for (const kind of ["conversation", "agent", "trigger"]) {
    assert.equal(
      sameWorkspaceDirectoryScope(
        key(kind, "", "project-a"),
        key(kind, "", "project-b"),
      ),
      false,
    );
  }
});

test("same-Project directory transitions retain their existing pages", () => {
  const samePageScope = key("conversation", "", "project-a");
  assert.equal(
    sameWorkspaceDirectoryScope(samePageScope, samePageScope),
    true,
  );
  assert.equal(
    sameWorkspaceDirectoryScope(
      key("conversation", "old search", "project-a"),
      key("conversation", "new search", "project-a", "alphabetical"),
    ),
    true,
  );
});

test("active-only Agent pages never retain unfiltered placeholders", () => {
  assert.equal(
    sameWorkspaceDirectoryScope(
      key("agent", "", undefined),
      key("agent", "", undefined, "last_used", true),
    ),
    false,
  );
});

test("Recent Outcomes pages never retain ordinary Agent placeholders", () => {
  const ordinary = key("agent", "", undefined);
  const outcomes = queryKeys.workspaceDirectory.list(
    "agent", "", undefined, undefined, undefined, undefined,
    undefined, true, undefined,
  );
  assert.equal(sameWorkspaceDirectoryScope(ordinary, outcomes), false);
});

test("bounded picker windows never retain complete management collections", () => {
  const directory = key("conversation", "", undefined);
  const picker = [...directory, 1];
  assert.equal(sameWorkspaceDirectoryScope(directory, picker), false);
  assert.equal(sameWorkspaceDirectoryScope(picker, directory), false);
  assert.equal(sameWorkspaceDirectoryScope(picker, [...picker]), true);
  assert.equal(sameWorkspaceDirectoryScope(picker, [...directory, 2]), false);
});

test("Project panels fail closed on foreign directory rows", () => {
  for (const kind of ["conversation", "agent", "trigger"]) {
    const rows = [
      { kind, project: { id: "project-a" }, id: `${kind}-a` },
      { kind, project: { id: "project-b" }, id: `${kind}-b` },
    ];
    assert.deepEqual(
      projectScopedWorkspaceDirectoryItems(rows, "project-b"),
      [rows[1]],
    );
  }
});
