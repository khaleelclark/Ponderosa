import assert from "node:assert/strict";
import test from "node:test";
import { newChatSubmission } from "../src/conversationRouting.js";

test("an explicit new-Chat broadcast never becomes an Agent creation", () => {
  assert.deepEqual(newChatSubmission("#broadcast Shared context"), {
    kind: "broadcast",
    text: "Shared context",
  });
  assert.deepEqual(newChatSubmission("Shared context #broadcast"), {
    kind: "broadcast",
    text: "Shared context",
  });
});

test("an ordinary first message keeps the existing new-Agent behavior", () => {
  assert.deepEqual(newChatSubmission("Please help with this"), {
    kind: "agent",
    text: "Please help with this",
  });
});
