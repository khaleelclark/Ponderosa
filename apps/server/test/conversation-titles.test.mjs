import assert from "node:assert/strict";
import test from "node:test";
import {
  conciseConversationTitle,
  semanticConversationTitle,
} from "../dist/conversation-titles.js";

test("the first operator message is sufficient for a Chat title", () => {
  assert.equal(
    semanticConversationTitle("Help me plan a product launch"),
    "Help me plan a product",
  );
  assert.equal(
    conciseConversationTitle("#broadcast Investigate the failing import workflow"),
    "Investigate the failing import workflow",
  );
});
