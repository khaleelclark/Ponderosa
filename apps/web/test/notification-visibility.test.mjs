import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationIsSufficientlyVisible,
  notificationVisibilityThreshold,
  observeNotificationVisibility,
  requeueFailedVisibleNotificationRead,
  requeueVisibleNotificationReads,
} from "../src/notificationVisibility.js";

function entry({
  elementHeight,
  visibleHeight,
  rootHeight,
  elementWidth = 300,
  visibleWidth = 300,
  rootWidth = 300,
}) {
  return {
    isIntersecting: visibleHeight > 0 && visibleWidth > 0,
    boundingClientRect: { height: elementHeight, width: elementWidth },
    intersectionRect: { height: visibleHeight, width: visibleWidth },
    rootBounds: { height: rootHeight, width: rootWidth },
  };
}

test("a tall mobile item becomes visible after half a viewport is exposed", () => {
  assert.equal(notificationVisibilityThreshold(3_000, 1_000, 300, 300), 1 / 12);
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

test("a horizontal sliver cannot acknowledge an otherwise visible item", () => {
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 100,
    visibleHeight: 100,
    rootHeight: 800,
    elementWidth: 600,
    visibleWidth: 1,
    rootWidth: 800,
  })), false);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 100,
    visibleHeight: 50,
    rootHeight: 800,
    elementWidth: 600,
    visibleWidth: 300,
    rootWidth: 800,
  })), true);
});

test("an item wider than a narrow mobile root needs half the available width", () => {
  assert.equal(notificationVisibilityThreshold(200, 500, 600, 300), 0.125);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 200,
    visibleHeight: 100,
    rootHeight: 500,
    elementWidth: 600,
    visibleWidth: 149,
    rootWidth: 300,
  })), false);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 200,
    visibleHeight: 100,
    rootHeight: 500,
    elementWidth: 600,
    visibleWidth: 150,
    rootWidth: 300,
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

test("reconnect during a final request defers exactly one fresh retry cycle", () => {
  const visible = new Set(["visible"]);
  const completed = new Set();
  const pending = new Set();
  const inFlight = new Set(["visible"]);
  const deferred = new Set();
  const retries = new Map([["visible", 3]]);

  requeueVisibleNotificationReads(visible, completed, pending, retries, inFlight, deferred);
  requeueVisibleNotificationReads(visible, completed, pending, retries, inFlight, deferred);

  assert.deepEqual([...deferred], ["visible"]);
  assert.equal(pending.size, 0);
  assert.equal(retries.has("visible"), false);
  assert.equal(requeueFailedVisibleNotificationRead(
    "visible",
    true,
    visible,
    pending,
    retries,
    deferred,
  ), 250);
  assert.deepEqual([...pending], ["visible"]);
  assert.equal(deferred.size, 0);
});

test("successful and unmounted reads cannot be requeued", () => {
  const visible = new Set(["read"]);
  const completed = new Set(["read"]);
  const pending = new Set();
  const inFlight = new Set();
  const deferred = new Set(["failed"]);
  const retries = new Map();

  requeueVisibleNotificationReads(visible, completed, pending, retries, inFlight, deferred);
  assert.equal(pending.size, 0);
  assert.equal(requeueFailedVisibleNotificationRead(
    "failed",
    false,
    new Set(["failed"]),
    pending,
    retries,
    deferred,
  ), undefined);
  assert.equal(pending.size, 0);
  assert.equal(deferred.size, 0);
});

test("visibility observer uses and resizes the nested Chat scroll root", (t) => {
  const originals = new Map([
    ["document", Object.getOwnPropertyDescriptor(globalThis, "document")],
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["IntersectionObserver", Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")],
    ["ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver")],
  ]);
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  let rootHeight = 300;
  const root = { getBoundingClientRect: () => ({ height: rootHeight, width: 300 }) };
  const element = {
    closest: (selector) => selector === ".chat-scroll-region" ? root : null,
    getBoundingClientRect: () => ({ height: 2_000, width: 300 }),
  };
  const intersectionObservers = [];
  const resizeObservers = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.disconnected = false;
      intersectionObservers.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      resizeObservers.push(this);
    }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { documentElement: { clientHeight: 900, clientWidth: 1_200 } } },
    window: { configurable: true, value: {
      innerHeight: 900,
      innerWidth: 1_200,
      addEventListener() {},
      removeEventListener() {},
    } },
    IntersectionObserver: { configurable: true, value: FakeIntersectionObserver },
    ResizeObserver: { configurable: true, value: FakeResizeObserver },
  });

  const visibility = [];
  const stop = observeNotificationVisibility(element, value => visibility.push(value));
  assert.equal(intersectionObservers[0].options.root, root);
  assert.equal(intersectionObservers[0].options.threshold, 0.0375);
  assert.deepEqual(resizeObservers[0].targets, [element, root]);
  intersectionObservers[0].callback([entry({
    elementHeight: 2_000,
    visibleHeight: 149,
    rootHeight: 300,
  })]);
  intersectionObservers[0].callback([entry({
    elementHeight: 2_000,
    visibleHeight: 150,
    rootHeight: 300,
  })]);
  assert.deepEqual(visibility, [false, true]);

  rootHeight = 600;
  resizeObservers[0].callback();
  assert.equal(intersectionObservers[0].disconnected, true);
  assert.equal(intersectionObservers[1].options.root, root);
  assert.equal(intersectionObservers[1].options.threshold, 0.075);
  stop();
  assert.equal(intersectionObservers[1].disconnected, true);
  assert.equal(resizeObservers[0].disconnected, true);
});

test("ordinary items require half their own height and width", () => {
  assert.equal(notificationVisibilityThreshold(200, 300, 300, 400), 0.25);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 200,
    visibleHeight: 99,
    rootHeight: 300,
  })), false);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 200,
    visibleHeight: 100,
    rootHeight: 300,
  })), true);
  assert.equal(notificationIsSufficientlyVisible(entry({
    elementHeight: 200,
    visibleHeight: 100,
    rootHeight: 300,
    visibleWidth: 149,
  })), false);
});
