import assert from "node:assert/strict";
import test from "node:test";
import { synchronizePristineDraft } from "../src/components/settingsDrafts.js";

test("canonical settings hydrate only pristine draft fields", () => {
  const drafts = {
    instructions: synchronizePristineDraft("typed instructions", "server instructions", true),
    concurrency: synchronizePristineDraft("8", "4", true),
    rolloverTokens: synchronizePristineDraft("150000", "200000", false),
    rolloverFraction: synchronizePristineDraft("0.7", "0.8", false),
  };
  assert.deepEqual(drafts, {
    instructions: "typed instructions",
    concurrency: "8",
    rolloverTokens: "200000",
    rolloverFraction: "0.8",
  });
  assert.equal(synchronizePristineDraft("8", "4", false), "4");
  assert.equal(synchronizePristineDraft("0.7", "0.8", true), "0.7");
});
