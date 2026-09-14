import assert from "node:assert/strict";
import test from "node:test";
import {
  refreshedMentionBindings,
  resolvedMentionBinding,
  submissionMentionBinding,
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

test("only an exact prepared retry may retain a deleted recipient binding", () => {
  assert.equal(
    submissionMentionBinding("old-name", [saved], [], false),
    undefined,
  );
  assert.deepEqual(
    submissionMentionBinding("old-name", [saved], [], true),
    saved,
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
    { ...current, handle: "old-name" },
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
    { ...renamed, handle: "old-name" },
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

test("a reloaded intermediate handle retains stable ownership through another rename", () => {
  const intermediate = {
    ...saved,
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const renamedAgain = {
    ...saved,
    handle: "newest-name",
    currentHandle: "newest-name",
    currentTitle: "Newest Name",
  };
  const replacement = {
    projectId: "project-a",
    agentId: "agent-b",
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "Replacement",
  };
  const refreshed = refreshedMentionBindings(
    "#new-name continue",
    [intermediate],
    [renamedAgain, replacement],
  );
  assert.deepEqual(refreshed, [{
    ...intermediate,
    handle: "new-name",
    currentHandle: "newest-name",
    currentTitle: "Newest Name",
  }]);
  assert.equal(
    resolvedMentionBinding("new-name", refreshed, [renamedAgain, replacement])
      ?.agentId,
    saved.agentId,
  );
});

test("two authored Agent IDs stay authoritative through same-draft handle reuse", () => {
  const other = {
    projectId: "project-a",
    agentId: "agent-b",
    handle: "other-name",
    currentHandle: "other-name",
    currentTitle: "Other Name",
  };
  const renamed = {
    ...saved,
    handle: "new-name",
    currentHandle: "new-name",
    currentTitle: "New Name",
  };
  const reused = {
    ...other,
    handle: "old-name",
    currentHandle: "old-name",
    currentTitle: "Reused Old Name",
  };
  const refreshed = refreshedMentionBindings(
    "#old-name ask A; #other-name ask B",
    [saved, other],
    [renamed, reused],
  );

  assert.equal(
    resolvedMentionBinding("old-name", refreshed, [renamed, reused])?.agentId,
    saved.agentId,
  );
  assert.equal(
    resolvedMentionBinding("other-name", refreshed, [renamed, reused])?.agentId,
    other.agentId,
  );
  assert.deepEqual(
    refreshedMentionBindings(
      "#old-name ask A; #other-name ask B",
      refreshed,
      [renamed, reused],
    ),
    refreshed,
  );
});
