import assert from "node:assert/strict";
import test from "node:test";
import { attentionPresentation, attentionSupportReport, isOpenAttention } from "../src/attention.js";
import { notificationTechnicalFocusId } from "../src/technicalFocus.js";

const notice = { id: "notice-123456789012", projectId: "project", projectLabel: "Glance",
  conversationId: "chat", conversationTitle: "Watch support", agentId: "agent", agentTitle: "Richmond",
  kind: "operational", category: "coordination", status: "open", severity: "attention",
  title: "Richmond's assignment needs review", body: "The provider stopped before reporting the assignment result.",
  createdAt: "2026-10-01T15:00:00Z", workContext: { kind: "request", recordId: "request-123456789012",
    state: "outcome_unknown", occurredAt: "2026-10-01T14:00:00Z", assignment: "Add a watch complication", traceId: "trace" } };

test("attention keeps exact work identity, recorded cause, task and incident time visible", () => {
  const copy = attentionPresentation(notice);
  assert.deepEqual(copy.scopes, ["Project: Glance", "Chat: Watch support", "Agent: Richmond"]);
  assert.equal(copy.explanation, notice.body);
  assert.equal(copy.task, "Add a watch complication");
  assert.equal(copy.occurredAt, notice.workContext.occurredAt);
  assert.match(copy.uncertainty, /cannot confirm.*finished/);
  assert.match(copy.uncertainty, /may duplicate changes/);
  assert.equal(copy.reference, "Assignment 123456789012");
  assert.equal(copy.compactScope, "Chat: Watch support");
  assert.equal(copy.summary, "Result unconfirmed. Check activity before retrying; retrying may duplicate changes.");
  assert.equal(copy.detailWarning, undefined, "the compact warning already covers unknown-outcome uncertainty");
  assert.equal(notificationTechnicalFocusId(notice), "request:request-123456789012");
  assert.match(attentionSupportReport(notice), /Work record: request:request-123456789012/);
  assert.equal(copy.evidenceUnavailable, false);
  assert.match(attentionPresentation({ ...notice, workContext: { ...notice.workContext,
    detail: "The required account connection was unavailable." } }).explanation, /account connection was unavailable/);
});

test("legacy fallbacks disclose missing evidence, retain scope references and do not invent a cause", () => {
  const legacy = { ...notice, workContext: undefined, projectLabel: undefined, conversationTitle: undefined,
    agentTitle: undefined, title: "A coordinated assignment needs a decision", body: "The coordinated workflow could not finish automatically." };
  const copy = attentionPresentation(legacy);
  assert.equal(copy.title, "Assigned work needs review");
  assert.equal(copy.evidenceUnavailable, true);
  assert.equal(copy.task, undefined);
  assert.equal(copy.taskUnavailableLabel, "Assignment description unavailable.");
  assert.match(copy.scopes.join(" · "), /Name unavailable/);
  assert.doesNotMatch(JSON.stringify(copy), /preserve.*open|will.*inspect|failed before delivering|completed successfully/);
  assert.notEqual(copy.reference, attentionPresentation({ ...legacy, id: "different-notice" }).reference);
  const system = attentionPresentation({ ...legacy, category: "system", title: "Project folder is unavailable",
    body: "The registered folder could not be opened." });
  assert.equal(system.evidenceUnavailable, false, "known system issues are not mislabeled as missing historical work evidence");
  assert.equal(system.uncertainty, undefined);
  assert.equal(system.summary, system.explanation, "specific recorded causes remain the summary, not an inferred failure");
  assert.match(copy.compactScope, /Chat: Name unavailable/);
  assert.equal(attentionPresentation({ ...notice, conversationId: undefined }).compactScope, "Project: Glance");
  assert.equal(attentionPresentation({ ...notice, conversationId: undefined, projectId: undefined }).compactScope, "Ponderosa workspace");
});

test("a failed wait does not claim every assignment failed and opens its exact canonical wait", () => {
  const item = { ...notice, workContext: { ...notice.workContext, kind: "join", state: "impossible", recordId: "join-id" } };
  assert.match(attentionPresentation(item).uncertainty, /does not mean every related assignment failed/);
  assert.equal(notificationTechnicalFocusId(item), "join:join-id");
  assert.equal(notificationTechnicalFocusId({ ...item, workContext: { ...item.workContext, kind: "trigger", recordId: "occurrence" } }), "trigger:occurrence");
});

test("reviewing a notice leaves it open; hiding only changes the notification projection", () => {
  assert.equal(isOpenAttention({ ...notice, acknowledgedAt: "2026-10-01T16:00:00Z" }), true);
  assert.equal(isOpenAttention({ ...notice, status: "dismissed" }), false);
  assert.equal(notice.workContext.state, "outcome_unknown");
});
