import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSuccessfulJsonResponse,
  requireSuccessfulResponse,
} from "./http-response.mjs";

test("successful qualification responses consume only the body required by their caller", async () => {
  let projectTextReads = 0;
  let projectJsonReads = 0;
  const project = await parseSuccessfulJsonResponse({
    ok: true,
    text: async () => {
      projectTextReads += 1;
      throw new Error("success body was consumed as text");
    },
    json: async () => {
      projectJsonReads += 1;
      if (projectJsonReads > 1) throw new Error("success body was parsed more than once");
      return { id: "project-1" };
    },
  }, "Project creation failed");

  assert.deepEqual(project, { id: "project-1" });
  assert.equal(projectTextReads, 0);
  assert.equal(projectJsonReads, 1);

  let capabilityBodyReads = 0;
  await requireSuccessfulResponse({
    ok: true,
    text: async () => {
      capabilityBodyReads += 1;
      return "unused success body";
    },
  }, "Capability discovery failed");
  assert.equal(capabilityBodyReads, 0);
});
