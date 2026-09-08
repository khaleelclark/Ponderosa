import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMarkdownUrlTransform,
  renderableChatLinkHref,
} from "../src/components/chat/chatMarkdownLink.js";

test("sanitized unsafe and empty Chat links remain inert", () => {
  for (const href of ["", "javascript:alert(1)", "data:text/html,unsafe"]) {
    assert.equal(renderableChatLinkHref(chatMarkdownUrlTransform(href)), undefined);
  }
});

test("safe and internal Chat links remain renderable", () => {
  for (const href of ["https://example.com/path", "ponderosa://project-file/file-a"]) {
    assert.equal(renderableChatLinkHref(chatMarkdownUrlTransform(href)), href);
  }
});
