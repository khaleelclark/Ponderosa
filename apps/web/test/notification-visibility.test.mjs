import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationIsSufficientlyVisible,
  notificationVisibilityThreshold,
  requeueVisibleNotificationReads,
} from "../src/notificationVisibility.js";

function entry({ elementHeight, visibleHeight, rootHeight }) {
  return {
    isIntersecting: visibleHeight > 0,
    boundingClientRect: { height: elementHeight },
    intersectionRect: { height: visibleHeight },
    rootBounds: { height: rootHeight },
  };
}

test("a tall mobile item becomes visible after half a viewport is exposed", () => {
  assert.equal(notificationVisibilityThreshold(3_000, 1_000), 1 / 6);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 3_000,
    visibleHeight: 499,
    rootHeight: 1_000,
  })), false);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 3_000,
    visibleHeight: 500,
    rootHeight: 1_000,
  })), true);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 500,
    visibleHeight: 250,
    rootHeight: 1_000,
  })), true);
});

test("online or workspace reconnect re-arms an exhausted visible read once", () => {
  const visible = new Set(["visible", "read", "hidden"]);
  const completed = new Set(["read"]);
  const pending = new Set();
  const retries = new Map([["visible", 3], ["hidden", 3]]);
  visible.delete("hidden");

  requeueVisibleNotificationReads(visible, completed, pending, retries);

  assert.deepEqual([...pending], ["visible"]);
  assert.equal(retries.has("visible"), false);
  assert.equal(retries.get("hidden"), 3);
});
