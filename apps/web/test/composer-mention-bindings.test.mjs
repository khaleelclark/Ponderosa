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
