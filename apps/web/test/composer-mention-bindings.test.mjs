import assert from "node:assert/strict";
import test from "node:test";
import {
  refreshedMentionBindings,
  resolvedMentionBinding,
} from "../src/components/chat/composerMentionBindings.js";

const saved = {
  projectId: "project-a",
  agentId: "agent-a",
  handle: "old-name",
  currentHandle: "old-name",
  currentTitle: "Old Name",
};

test("saved draft mentions retain stable identity through rename and deletion", () => {
  const renamed = refreshedMentionBindings("#old-name please continue", [saved], [{
    ...saved,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  }]);
  assert.deepEqual(renamed, [{
    ...saved,
    currentHandle: "new-name",
    currentTitle: "New Name",
  }]);

  assert.deepEqual(
    refreshedMentionBindings("#old-name please continue", renamed, []),
    renamed,
  );
});

test("saved draft handles route by stable identity after rename", () => {
  const current = {
    ...saved,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  assert.deepEqual(
    resolvedMentionBinding("old-name", [saved], [current]),
    current,
  );
  assert.equal(resolvedMentionBinding("old-name", [saved], []), undefined);
});

test("a renamed Agent keeps an authored handle if another Agent later reuses it", () => {
  const renamed = {
    ...saved,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const replacement = {
    projectId: "project-a",
    agentId: "agent-b",
    handle: "old-name",
    currentHandle: "old-name",
    currentTitle: "Replacement",
  };
  assert.deepEqual(
    refreshedMentionBindings("#old-name continue", [saved], [renamed, replacement]),
    [{ ...saved, currentHandle: "new-name", currentTitle: "New Name" }],
  );
  assert.deepEqual(
    resolvedMentionBinding("old-name", [saved], [renamed, replacement]),
    renamed,
  );
});

test("a deleted renamed Agent keeps ownership of its last displayed handle", () => {
  const renamedBinding = {
    ...saved,
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const replacement = {
    projectId: "project-a",
    agentId: "agent-b",
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "Replacement",
  };
  assert.deepEqual(
    refreshedMentionBindings("#new-name continue", [renamedBinding], [replacement]),
    [renamedBinding],
  );
  assert.equal(
    resolvedMentionBinding("new-name", [renamedBinding], [replacement]),
    undefined,
  );
});

test("one stable Agent owns both its authored and renamed handles", () => {
  const renamed = {
    ...saved,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const refreshed = refreshedMentionBindings(
    "#old-name #new-name",
    [saved],
    [renamed],
  );
  assert.deepEqual(refreshed, [{
    ...saved,
    currentHandle: "new-name",
    currentTitle: "New Name",
  }]);
  assert.equal(
    resolvedMentionBinding("old-name", refreshed, [renamed])?.agentId,
    saved.agentId,
  );
  assert.equal(
    resolvedMentionBinding("new-name", refreshed, [renamed])?.agentId,
    saved.agentId,
  );
});
