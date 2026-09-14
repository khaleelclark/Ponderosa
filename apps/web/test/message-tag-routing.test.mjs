import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_TAG_PREFIX,
  messageTagHandle,
} from "../src/mentions.js";

test("malformed internal message tags remain inert", () => {
  for (const href of [
    `${MESSAGE_TAG_PREFIX}%ZZ`,
    `${MESSAGE_TAG_PREFIX}%E0%A4%A`,
    MESSAGE_TAG_PREFIX,
  ]) {
    assert.equal(messageTagHandle(href), undefined);
  }
  assert.equal(messageTagHandle("https://example.com"), undefined);
});

test("valid generated message tags retain their readable handle", () => {
  const handle = "équipe-一";
  assert.equal(
    messageTagHandle(`${MESSAGE_TAG_PREFIX}${encodeURIComponent(handle)}`),
    handle,
  );
});
