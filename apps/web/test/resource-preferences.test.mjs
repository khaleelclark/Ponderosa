import assert from "node:assert/strict";
import test from "node:test";
import {
  customOrderSeed,
  projectOrderPreferenceKey,
  sortChatFolderMembers,
  sortChatFolders,
  synchronizeProjectRailOrder,
} from "../src/resourcePreferences.js";

test("canonical Project order changes produce a new rail synchronization key", () => {
  const first = projectOrderPreferenceKey({ projectSort: "custom", projectOrder: ["a", "b"] });
  const reordered = projectOrderPreferenceKey({ projectSort: "custom", projectOrder: ["b", "a"] });
  const alphabetical = projectOrderPreferenceKey({ projectSort: "alphabetical", projectOrder: ["a", "b"] });
  assert.notEqual(first, reordered);
  assert.notEqual(first, alphabetical);
  assert.deepEqual(
    synchronizeProjectRailOrder(["a", "b"], ["b", "a"], true),
    ["b", "a"],
  );
  assert.deepEqual(
    synchronizeProjectRailOrder(["a", "b"], ["b", "a", "c"], false),
    ["a", "b", "c"],
  );
});

test("alphabetical Project identity changes resynchronize without changing custom order", () => {
  const alphabetical = { projectSort: "alphabetical", projectOrder: [] };
  const beforeRename = projectOrderPreferenceKey(alphabetical, [
    { id: "b", label: "Beta" },
    { id: "a", label: "Zulu" },
  ]);
  const afterRename = projectOrderPreferenceKey(alphabetical, [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ]);
  assert.notEqual(beforeRename, afterRename);

  const custom = { projectSort: "custom", projectOrder: ["b", "a"] };
  assert.equal(
    projectOrderPreferenceKey(custom, [{ id: "b", label: "Before" }]),
    projectOrderPreferenceKey(custom, [{ id: "b", label: "After" }]),
  );
});

test("Chat folders and their members follow Recent or A–Z; Custom preserves dragged order", () => {
  const items = [
    { conversation: { id: "z", title: "Zulu", updatedAt: "2026-09-19T00:00:00Z" } },
    { conversation: { id: "a", title: "Alpha", updatedAt: "2026-09-18T00:00:00Z" } },
    { conversation: { id: "b", title: "Beta", updatedAt: "2026-09-16T00:00:00Z" } },
  ];
  const folders = [
    { id: "second", name: "Zulu folder", conversationIds: ["z", "a"], expanded: true },
    { id: "first", name: "Alpha folder", conversationIds: ["b"], expanded: true },
  ];
  assert.deepEqual(sortChatFolders(folders, items, "alphabetical").map(folder => folder.id), ["first", "second"]);
  assert.deepEqual(sortChatFolders(folders, items, "last_used").map(folder => folder.id), ["second", "first"]);
  assert.deepEqual(sortChatFolders(folders, items, "custom").map(folder => folder.id), ["second", "first"]);
  assert.deepEqual(sortChatFolderMembers(folders[0], items, "alphabetical").map(item => item.conversation.id), ["a", "z"]);
  assert.deepEqual(sortChatFolderMembers(folders[0], items, "last_used").map(item => item.conversation.id), ["z", "a"]);
  assert.deepEqual(sortChatFolderMembers(folders[0], items, "custom").map(item => item.conversation.id), ["z", "a"]);
});

test("switching to Custom seeds visible order without discarding off-page IDs", () => {
  assert.deepEqual(customOrderSeed(["older", "a"], ["b", "a"]), ["b", "a", "older"]);
});
