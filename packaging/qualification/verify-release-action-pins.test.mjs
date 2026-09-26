import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseActionPins } from "./verify-release-action-pins.mjs";

test("release Action pins require exact commit objects, not annotated tags", async () => {
  const seen = [];
  const count = await verifyReleaseActionPins(async (repository, sha) => {
    seen.push(`${repository}@${sha}`);
    return sha;
  });
  assert.ok(count >= 6);
  assert.equal(seen.length, count);
  assert.ok(seen.includes("pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1"));
  assert.ok(seen.includes("actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be"));
  await assert.rejects(
    verifyReleaseActionPins(async () => undefined),
    /did not resolve to the exact commit object/u,
  );
});
