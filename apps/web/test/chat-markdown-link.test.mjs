import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMarkdownUrlTransform,
  parseChatProjectFileHref,
  renderableChatLinkHref,
} from "../src/components/chat/chatMarkdownLink.js";

test("sanitized unsafe and empty Chat links remain inert", () => {
  for (const href of ["", "javascript:alert(1)", "data:text/html,unsafe"]) {
    assert.equal(renderableChatLinkHref(chatMarkdownUrlTransform(href)), undefined);
  }
});

test("safe and internal Chat links remain renderable", () => {
  for (const href of ["https://example.com/path", "ponderosa://project-file/project-a/file-a?historical=old.txt&current=new.txt"]) {
    assert.equal(renderableChatLinkHref(chatMarkdownUrlTransform(href)), href);
  }
  assert.deepEqual(parseChatProjectFileHref("ponderosa://project-file/project-a/file-a"), {
    projectId: "project-a", artifactId: "file-a", historicalFilename: "Project file", currentFilename: "",
  });
});

test("malformed internal project-file links remain inert", () => {
  for (const href of [
    "ponderosa://project-file/file-a",
    "ponderosa://project-file/project-a/file-a/extra",
    "ponderosa://project-file/project-a/%ZZ",
    "ponderosa://project-file/project-a/file-a?current=%ZZ",
    "other://project-file/project-a/file-a",
  ]) {
    assert.equal(renderableChatLinkHref(chatMarkdownUrlTransform(href)), undefined);
    assert.equal(parseChatProjectFileHref(href), undefined);
  }
});
