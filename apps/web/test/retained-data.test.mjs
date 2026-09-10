import assert from "node:assert/strict";
import test from "node:test";
import { loadRetainedData, retainedDataState } from "../src/retainedData.js";

test("rejected pagination is caught while retained data remains authoritative", async () => {
  let error;
  const retained = ["existing"];
  const page = await loadRetainedData(
    async () => { throw new Error("offline"); },
    value => { error = value; },
    "Older items could not be loaded.",
  );
  assert.equal(page, undefined);
  assert.deepEqual(retained, ["existing"]);
  assert.match(error, /Older items could not be loaded\. offline/u);
});

test("collection state never presents unresolved or failed data as empty", () => {
  assert.equal(retainedDataState(false, false), "loading");
  assert.equal(retainedDataState(false, true), "error");
  assert.equal(retainedDataState(true, true), "ready");
});
