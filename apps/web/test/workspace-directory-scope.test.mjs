import assert from "node:assert/strict";
import test from "node:test";
import {
  projectScopedWorkspaceDirectoryItems,
  sameWorkspaceDirectoryScope,
} from "../src/workspaceDirectoryScope.js";
import { queryKeys } from "../src/queryKeys.js";

const key = (kind, search, projectId, sort = "last_used") =>
  queryKeys.workspaceDirectory.list(
    kind,
    search,
    projectId,
    undefined,
    undefined,
    sort,
  );

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
