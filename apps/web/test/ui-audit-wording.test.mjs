import assert from "node:assert/strict";
import test from "node:test";
import { markdownPreviewText } from "../src/markdownPreviewText.js";
import { decisionResponseSummary } from "../src/components/decisions/decisionResponse.js";
import { presentedFileIdentity } from "../src/projectPathPresentation.js";
import { workspaceMarkdownMediaHref, renderableWorkspaceMarkdownHref } from "../src/components/filePreview/workspaceMarkdownLinks.js";
import { routeToPath } from "../src/routeRegistry.js";
import { parseRoute, routeReturnTarget } from "../src/routing.js";
import { capabilityDisplayName, matchingComposerCapabilities, insertComposerCapability } from "../src/components/chat/composerUtils.js";
import { resolveRuntimeSelection, engineAvailabilityPresentation } from "../src/conversationEngine.js";
import { prepareDownload } from "../src/downloads.js";

test("download feedback preserves the larger encoded Agent-package envelope without raising the file limit", async t => {
  let clicks = 0;
  t.mock.method(globalThis, "fetch", async () => new Response("package bytes", { headers: { "Content-Length": String(85 * 1024 * 1024) } }));
  t.mock.method(globalThis, "setTimeout", callback => { callback(); return 0; });
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ dataset: {}, click: () => clicks++, remove() {} }), body: { append() {} } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  await prepareDownload("/api/agents/agent/export?download=1", "agent.ponderosa.json");
  assert.equal(clicks, 1);
  await assert.rejects(prepareDownload("/api/attachments/file/download", "file.bin"), /80 MiB/);
  t.mock.method(globalThis, "fetch", async () => new Response("package bytes", { headers: { "Content-Length": String(97 * 1024 * 1024) } }));
  await assert.rejects(prepareDownload("/api/agents/agent/export?download=1", "agent.ponderosa.json"), /96 MiB/);
  assert.equal(clicks, 1, "rejected downloads never hand off or announce success");
});

test("notification Markdown becomes readable preview text without changing meaningful underscores", () => {
  assert.equal(markdownPreviewText("## **Import complete**\n\nReview [the files](https://example.com) and *saved history*. `file_name`"), "Import complete Review the files and saved history. file_name");
  assert.equal(markdownPreviewText("> __Important__\n- One\n- Two\n```text\ncode\n```"), "Important One Two code");
});
test("provider availability joins preserve existing sentence punctuation", () => {
  for (const detail of ['Sign in again.', 'Try again!', 'Unavailable?', 'Still checking…', 'Sign in again']) {
    const result = engineAvailabilityPresentation([{ id: 'codex', displayName: 'Codex', authentication: 'error', intakeReady: false, availabilityDetail: detail }]);
    assert.doesNotMatch(result.detail, /[.!?…]\./u);
    assert.match(result.detail, /Codex is status unavailable/);
  }
});
test("decision wording follows its recorded response kind and preserves punctuation", () => {
  assert.equal(decisionResponseSummary({ mode: "choice", response: { text: "Yes!" } }, "Yes!"), "You answered Yes!");
  assert.equal(decisionResponseSummary({ mode: "choice", response: { choiceId: "a" } }, "Proceed."), "You chose Proceed.");
  assert.equal(decisionResponseSummary({ mode: "approval", response: { choiceId: "approve" } }, "Approved"), "Your approval response: Approved");
});
test("relative media and link routes retain authorization and return context", () => {
  const scope = { conversationId: "chat", returnTo: "/projects/p/chats/chat?view=files" };
  const image = new URL(workspaceMarkdownMediaHref("p", "docs/report.md", "images/photo.png", scope), "http://localhost");
  assert.equal(image.pathname, "/api/projects/p/workspace-files/preview");
  assert.equal(image.searchParams.get("path"), "docs/images/photo.png");
  assert.equal(image.searchParams.get("conversationId"), "chat");
  for (const src of ["../../escape.png", "bad%ZZ.png", "%2Fetc%2Fpasswd", "javascript:alert(1)", "photo.svg"]) assert.equal(workspaceMarkdownMediaHref("p", "docs/report.md", src, scope), undefined);
  const href = renderableWorkspaceMarkdownHref("p", "docs/report.md", "other.md#title", scope);
  const route = parseRoute(href.split("#")[0]);
  assert.equal(route.conversationId, "chat");
  assert.equal(routeToPath(routeReturnTarget(route.returnTo, { kind: "home" })), scope.returnTo);
  assert.equal(routeToPath(routeReturnTarget("https://evil.invalid", { kind: "manageAutomations" })), "/manage/automations");
});
test("external files keep distinguishable safe identities without disclosing private parent paths", () => {
  const a = presentedFileIdentity("/project", "/private/one/README.md");
  const b = presentedFileIdentity("/project", "/private/two/README.md");
  assert.notEqual(a, b);
  assert.match(a, /README.md/);
  assert.doesNotMatch(a, /private|\/one/);
});
test("capability search matches the displayed name and keeps the exact runtime command", () => {
  const capability = { label: "review-agent", kind: "skill", status: "available", description: "Inspect work", insertText: "$review-agent " };
  assert.equal(capabilityDisplayName(capability), "Review Agent");
  for (const term of ["Review Agent", "review-agent", "inspect"]) assert.deepEqual(matchingComposerCapabilities([capability], term), [capability]);
  assert.deepEqual(insertComposerCapability("Check ", 6, capability), { text: "Check $review-agent ", caret: 20 });
});
test("displayed effective defaults use runtime's explicit, Chat, saved, and provider precedence", () => {
  const engine = { id: "codex", models: ["explicit", "chat", "saved", "provider"].map(id => ({ id, label: id })), efforts: [{ id: "high", label: "High" }], defaultModel: "provider", defaultEffort: "high" };
  const saved = { engineDefaults: { codex: { model: "saved", effort: "high" } } };
  const chat = { defaultEngine: "codex", defaultModel: "chat", defaultEffort: "high" };
  assert.equal(resolveRuntimeSelection(engine, saved, chat, { model: "explicit" }).model, "explicit");
  assert.equal(resolveRuntimeSelection(engine, saved, chat).model, "chat");
  assert.equal(resolveRuntimeSelection(engine, saved).model, "saved");
  assert.equal(resolveRuntimeSelection(engine, {}).model, "provider");
  assert.equal(resolveRuntimeSelection(engine, saved, chat, { model: "not-in-provider-roster" }).model, "chat");
});
