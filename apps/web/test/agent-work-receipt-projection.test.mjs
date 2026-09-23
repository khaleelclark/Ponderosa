import assert from "node:assert/strict";
import test from "node:test";
import { PONDEROSA_MESSAGE_TOOL } from "@ponderosa/core";
import {
  hasVisibleReceiptActivity,
  receiptActivityEntries,
} from "../src/components/chat/receiptActivityEntries.js";

const createdAt = "2026-09-20T12:00:00.000Z";

function messageAttempt(id, seq, isError, intent = "broadcast") {
  return {
    id,
    seq,
    createdAt,
    kind: "tool",
    name: PONDEROSA_MESSAGE_TOOL.name,
    input: { intent, content: `canonical ${intent} text` },
    result: {
      activityId: `${id}-result`,
      agentId: "agent-a",
      seq: seq + 1,
      completedAt: createdAt,
      output: isError ? "delivery rejected" : "delivery committed",
      isError,
    },
  };
}

function ordinaryTool(id, seq, isError) {
  return {
    id,
    seq,
    createdAt,
    kind: "tool",
    name: "ordinary_tool",
    input: { value: "copyable content" },
    result: {
      activityId: `${id}-result`,
      agentId: "agent-a",
      seq: seq + 1,
      completedAt: createdAt,
      output: "ordinary output",
      isError,
    },
  };
}

const terminalNotices = entries => entries.filter(entry =>
  entry.kind === "notice" && entry.title === "Message delivery failed; task completed");

test("completed Run with one failed message attempt shows one terminal warning", () => {
  const entries = receiptActivityEntries([messageAttempt("failed", 10, true)], "completed");
  assert.equal(terminalNotices(entries).length, 1);
});

test("completed Run with a failed attempt followed by success has no terminal warning", () => {
  const failed = messageAttempt("failed", 10, true);
  const entries = receiptActivityEntries([failed, messageAttempt("success", 20, false)], "completed");
  assert.deepEqual(entries, [failed]);
  assert.equal(terminalNotices(entries).length, 0);
});

test("two failures followed by success remain auditable without a terminal warning", () => {
  const first = messageAttempt("failed-1", 10, true);
  const second = messageAttempt("failed-2", 20, true);
  const entries = receiptActivityEntries([first, second, messageAttempt("success", 30, false)], "completed");
  assert.deepEqual(entries, [first, second]);
  assert.equal(terminalNotices(entries).length, 0);
});

test("success followed by failure shows one warning for the final attempt", () => {
  const entries = receiptActivityEntries([
    messageAttempt("success", 10, false),
    messageAttempt("failed", 20, true),
  ], "completed");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "failed");
  assert.equal(terminalNotices(entries).length, 1);
});

test("multiple failures without success produce one terminal warning", () => {
  const first = messageAttempt("failed-1", 10, true);
  const entries = receiptActivityEntries([
    first,
    messageAttempt("failed-2", 20, true),
  ], "completed");
  assert.deepEqual(entries[0], first);
  assert.equal(terminalNotices(entries).length, 1);
});

test("running Run retains failed and unsettled attempts without a completed-task notice", () => {
  const failed = messageAttempt("failed", 10, true);
  const unsettled = { ...messageAttempt("pending", 20, false), result: undefined };
  const entries = receiptActivityEntries([failed, unsettled], "running");
  assert.deepEqual(entries, [failed, unsettled]);
  assert.equal(terminalNotices(entries).length, 0);
});

test("unsettled message attempt keeps a standalone work receipt visible", () => {
  const unsettled = { ...messageAttempt("pending", 20, false), result: undefined };
  assert.equal(hasVisibleReceiptActivity([unsettled], "completed"), true);
});

test("ordinary tool failures remain unchanged when message delivery succeeds", () => {
  const failure = ordinaryTool("ordinary-failure", 10, true);
  const entries = receiptActivityEntries([
    failure,
    messageAttempt("success", 20, false),
  ], "completed");
  assert.deepEqual(entries, [failure]);
});

test("final outcome follows canonical seq rather than incoming array order", () => {
  const entries = receiptActivityEntries([
    messageAttempt("later-success", 30, false),
    messageAttempt("earlier-failure", 10, true),
    messageAttempt("middle-failure", 20, true),
  ], "completed");
  assert.deepEqual(entries.map(entry => entry.id), ["earlier-failure", "middle-failure"]);
  assert.equal(terminalNotices(entries).length, 0);
});

test("Broadcast, Direct Message, and Collaboration use identical attempt outcome handling", () => {
  for (const intent of ["broadcast", "direct_to_user", "collaboration"]) {
    const failed = messageAttempt(`${intent}-failed`, 10, true, intent);
    const entries = receiptActivityEntries([
      failed,
      messageAttempt(`${intent}-success`, 20, false, intent),
    ], "completed");
    assert.deepEqual(entries, [failed]);
    assert.equal(entries[0].input.content, `canonical ${intent} text`);
  }
});

test("projection does not alter canonical text or copyable ordinary activity", () => {
  const ordinary = ordinaryTool("ordinary", 10, false);
  const failed = messageAttempt("message-failure", 20, true, "direct");
  const entries = receiptActivityEntries([ordinary, failed], "completed");
  assert.strictEqual(entries[0], ordinary);
  assert.equal(entries[0].input.value, "copyable content");
  assert.equal(failed.input.content, "canonical direct text");
});
