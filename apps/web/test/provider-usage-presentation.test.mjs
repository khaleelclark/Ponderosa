import assert from "node:assert/strict";
import test from "node:test";
import { providerUsageCollectionPresentation } from "../src/components/providerUsagePresentation.js";

test("provider usage distinguishes loading, transport failure, and genuine empty state", () => {
  assert.deepEqual(providerUsageCollectionPresentation(0, true), { kind: "loading" });
  assert.deepEqual(
    providerUsageCollectionPresentation(0, false, new Error("Host unavailable")),
    { kind: "error", message: "Host unavailable" },
  );
  assert.deepEqual(providerUsageCollectionPresentation(0, false), { kind: "empty" });
});

test("cached provider usage survives query and manual refresh failure", () => {
  assert.deepEqual(
    providerUsageCollectionPresentation(1, false, new Error("Refresh failed")),
    { kind: "ready", warning: "Refresh failed" },
  );
  assert.deepEqual(
    providerUsageCollectionPresentation(1, false),
    { kind: "ready" },
  );
});
