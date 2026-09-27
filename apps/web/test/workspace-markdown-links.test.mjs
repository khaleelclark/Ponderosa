import assert from "node:assert/strict";
import test from "node:test";
import { renderableWorkspaceMarkdownHref, workspaceMarkdownFileHref } from "../src/components/filePreview/workspaceMarkdownLinks.js";

test("relative Markdown links stay in the same Project file viewer", () => {
  const current = "gen3-20260926/GEN3_COMPLETE_RELOCATION_REPORT.md";
  assert.equal(
    workspaceMarkdownFileHref("project-a", current, "GEN3_HOUSEHOLD_MODEL.md"),
    "/projects/project-a/files/view?path=gen3-20260926%2FGEN3_HOUSEHOLD_MODEL.md",
  );
  assert.equal(
    workspaceMarkdownFileHref("project-a", current, "../overview/notes%20today.md#section"),
    "/projects/project-a/files/view?path=overview%2Fnotes%20today.md#section",
  );
});

test("rejected Project links are inert while external, in-page and safe root links survive", () => {
  const current = "gen3-20260926/report.md";
  for (const href of ["../../outside.md", "%2Fetc%2Fpasswd", "bad%ZZ.md", "javascript:alert(1)", "file:///etc/passwd", "/../outside.md", "//example.com/docs"]) {
    assert.equal(renderableWorkspaceMarkdownHref("project-a", current, href), undefined, href);
  }
  for (const href of ["https://example.com", "mailto:person@example.com", "#section", "/home"]) {
    assert.equal(renderableWorkspaceMarkdownHref("project-a", current, href), href);
  }
  assert.equal(renderableWorkspaceMarkdownHref("project-a", current, "../overview/notes.md"),
    "/projects/project-a/files/view?path=overview%2Fnotes.md");
});

test("external, in-page, and escaping links are not rewritten", () => {
  const current = "gen3-20260926/report.md";
  for (const href of ["https://example.com", "mailto:person@example.com", "#section", "/home", "//example.com", "../../outside.md", "%2Fetc%2Fpasswd", "javascript:alert(1)"]) {
    assert.equal(workspaceMarkdownFileHref("project-a", current, href), undefined, href);
  }
});
