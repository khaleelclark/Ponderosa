import assert from "node:assert/strict";
import { test } from "node:test";
import { isCommunicationEvent } from "../dist/index.js";

const canonical = {
  eventId: "event-1",
  schemaVersion: 2,
  projectId: "project-1",
  sender: { kind: "system", component: "launcher" },
  intent: "user_dm",
  audience: { kind: "user", userId: "local-user" },
  text: "Current schema",
  createdAt: "2026-08-31T00:00:00.000Z",
};

test("accepts the current communication schema", () => {
  assert.equal(isCommunicationEvent(canonical), true);
});

test("rejects pre-v2 communication events", () => {
  assert.equal(isCommunicationEvent({
    ...canonical,
    schemaVersion: 1,
    intent: "direct_to_user",
    audience: { kind: "user", userId: "local-user" },
  }), false);
});
