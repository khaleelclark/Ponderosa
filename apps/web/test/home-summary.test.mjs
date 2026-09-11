import assert from "node:assert/strict";
import test from "node:test";
import { notificationOpenActionCount } from "../src/attention.js";

test("Home uses the authoritative action count when an older action is beyond the loaded page", () => {
  const newestUpdates = Array.from({ length: 100 }, (_, index) => ({
    id: `update-${index}`,
    kind: "update",
    status: "open",
  }));
  assert.equal(notificationOpenActionCount(newestUpdates), 0);
  assert.equal(notificationOpenActionCount(newestUpdates, { openActionCount: 1 }), 1);
});
