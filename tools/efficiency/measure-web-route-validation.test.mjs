import assert from "node:assert/strict";
import test from "node:test";
import { validateOfflineSnapshot } from "./measure-web-route-validation.mjs";

const passing = {
  expectedUrl: "http://127.0.0.1:4317/settings",
  expectedRouteKind: "settings",
  timedOut: false,
  snapshot: {
    pathname: "/settings",
    controlled: true,
    routeKind: "settings",
    routePath: "/settings",
    errorBoundary: false,
    routeChunkError: false,
    routeContentPresent: true,
    routeText: "Settings",
  },
};

test("accepts only a controlled, rendered, matching offline route", () => {
  assert.doesNotThrow(() => validateOfflineSnapshot(passing));
});

for (const [name, patch] of [
  ["timeout", { timedOut: true }],
  ["uncontrolled worker", { snapshot: { ...passing.snapshot, controlled: false } }],
  ["wrong pathname", { snapshot: { ...passing.snapshot, pathname: "/" } }],
  ["wrong route marker", { snapshot: { ...passing.snapshot, routeKind: "home" } }],
  ["wrong route path", { snapshot: { ...passing.snapshot, routePath: "/" } }],
  ["workspace error boundary", { snapshot: { ...passing.snapshot, errorBoundary: true } }],
  ["chunk error recovery", { snapshot: { ...passing.snapshot, routeChunkError: true } }],
  ["missing route content marker", { snapshot: { ...passing.snapshot, routeContentPresent: false } }],
  ["shell-only page", { snapshot: { ...passing.snapshot, routeText: "  " } }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => validateOfflineSnapshot({ ...passing, ...patch }),
      /offline route qualification failed/u,
    );
  });
}
