import assert from "node:assert/strict";
import test from "node:test";
import {
  toggleManagedRow,
  toggleManagedVisibleRows,
  uniqueManagedRows,
} from "../src/hooks/useManagedWorkspaceCollection.js";

const row = (id, label = id) => ({ kind: "conversation", conversation: { id, title: label } });
const id = item => item.conversation.id;

test("management rows put starred entries first and deduplicate across pages", () => {
  const starred = row("a", "starred version");
  const rows = uniqueManagedRows([
    { starredItems: [starred], items: [row("a", "page version"), row("b")] },
    { starredItems: [], items: [row("b"), row("c")] },
  ], id);
  assert.deepEqual(rows.map(id), ["a", "b", "c"]);
  assert.equal(rows[0], starred);
  assert.deepEqual(uniqueManagedRows(undefined, id), []);
});

test("management selection preserves hidden rows and toggles only visible rows", () => {
  const hidden = row("hidden");
  const a = row("a");
  const b = row("b");
  const initial = new Map([["hidden", hidden]]);
  const selected = toggleManagedVisibleRows(initial, [a, b], id);
  assert.deepEqual([...selected.keys()], ["hidden", "a", "b"]);
  assert.deepEqual([...initial.keys()], ["hidden"]);
  const deselected = toggleManagedVisibleRows(selected, [a, b], id);
  assert.deepEqual([...deselected.keys()], ["hidden"]);
  assert.deepEqual([...toggleManagedVisibleRows(initial, [], id).keys()], ["hidden"]);
  assert.deepEqual([...toggleManagedRow(selected, a, id).keys()], ["hidden", "b"]);
});
