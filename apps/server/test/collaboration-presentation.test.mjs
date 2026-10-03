import assert from "node:assert/strict";
import test from "node:test";
import { collaborationPresentation, missingCollaborationRecipients } from "@ponderosa/core";
import { collaborationFixture } from "./fixtures/collaboration-presentation.mjs";

test("persisted canonical Collaboration recipients do not guess hashtags or mutate authority", async t => {
  const fixture = await collaborationFixture();
  t.after(() => fixture.close());
  const before = fixture.authority();
  const [result, unknown, group] = fixture.messages();
  assert.equal(result.collaborationRecipients[0].id, fixture.boston.id);
  assert.deepEqual(unknown.agentMentions ?? [], []);
  assert.deepEqual(missingCollaborationRecipients(unknown.collaborationRecipients, unknown.agentMentions.map(m => m.agentId)).map(r => r.id), [fixture.boston.id]);
  assert.deepEqual(missingCollaborationRecipients(group.collaborationRecipients, group.agentMentions.map(m => m.agentId)).map(r => r.id), [fixture.juniper.id]);
  assert.deepEqual(before, fixture.authority());
  for (const event of fixture.events) assert.equal(fixture.store.getCommunicationEvent(fixture.project.id, event.eventId).text, event.text);
  assert.deepEqual(fixture.messages().map(m => m.text), fixture.events.map(e => e.text), "legacy rendered prefixes are not canonical/copyable text");
  const all = await fixture.allPage();
  assert.equal(all.items.length, 1, "All Messages scope filtering excludes Agent-to-Agent copies");
  assert.equal(all.items[0].author.kind, "user");
  assert.deepEqual(new Set(all.items[0].collaborationRecipients.map(r => r.id)), new Set([fixture.boston.id, fixture.juniper.id]));
});

test("historical spellings, deleted/reused names, ambiguity and nonrecipients stay safe", () => {
  const event = { schemaVersion: 2, eventId: "event", projectId: "project", sender: { kind: "agent", agentId: "cedar" },
    intent: "collaboration", audience: { kind: "agents", agentIds: ["old", "unicode", "unknown"] },
    text: "#Boston, #東京_支部! #Other #issue #東京_支部",
    identity: { senderLabel: "Cedar", recipientHandles: { old: "Boston", unicode: "東京_支部" }, recipientLabels: { old: "Boston", unicode: "Tokyo" } },
    createdAt: "2026-10-03T00:00:00Z" };
  const agents = [{ id: "old", handle: "Renamed-Agent", title: "Renamed" }, { id: "replacement", handle: "Boston", title: "Boston" },
    { id: "unicode", handle: "New_Tokyo", title: "New Tokyo" }, { id: "nonrecipient", handle: "Other", title: "Other" }];
  const projected = collaborationPresentation(event, agents);
  assert.equal(projected.agentMentions.find(m => m.handle === "Boston").agentId, "old");
  assert.equal(projected.agentMentions.find(m => m.handle === "東京_支部").handle, "東京_支部");
  assert.equal(projected.agentMentions.some(m => m.handle === "issue"), false);
  assert.equal(projected.collaborationRecipients[0].handle, "Boston");
  assert.deepEqual(missingCollaborationRecipients(projected.collaborationRecipients, projected.agentMentions.map(m => m.agentId)).map(r => r.id), ["unknown"]);
  const deleted = collaborationPresentation(event, agents.filter(a => a.id !== "old"));
  assert.equal(deleted.agentMentions.find(m => m.handle === "Boston").available, false);
  assert.equal(deleted.agentMentions.find(m => m.handle === "Boston").agentId, "old");
  const ambiguous = collaborationPresentation({ ...event, text: "#Boston", audience: { kind: "agents", agentIds: ["old", "second"] },
    identity: { senderLabel: "Cedar", recipientHandles: { old: "Boston", second: "Boston" } } }, agents);
  assert.deepEqual(ambiguous.agentMentions, []);
  assert.equal(missingCollaborationRecipients(ambiguous.collaborationRecipients, []).length, 2);
});

test("empty Collaboration enrichment replaces ambiguous legacy audit bindings", async t => {
  const f = await collaborationFixture(); t.after(() => f.close());
  const event = { ...f.events[0], eventId: "legacy-ambiguous", text: "#Same result",
    audience: { kind: "agents", agentIds: [f.boston.id, f.juniper.id] },
    identity: { senderLabel: "Cedar", recipientHandles: { [f.boston.id]: "Same", [f.juniper.id]: "Same" } } };
  f.store.appendCommunicationEvent(event);
  f.store.appendCommunicationProjection(f.project.id, { eventId: event.eventId, surface: "direct_agent_audit", projectionKey: f.cedar.id,
    projectedAt: event.createdAt, message: { messageId: event.eventId, sequence: 1, role: "assistant", createdAt: event.createdAt,
      authorAgentId: f.cedar.id, renderedText: event.text } });
  const page = f.store.getProjectedAgentMessagePage(f.cedar.id, { limit: 50 });
  const legacy = page.messages.find(message => message.communicationEventId === event.eventId);
  assert(legacy, "actual persisted audit projection supplies the legacy DTO");
  const projected = f.readModels.withMessagePresentation(f.project.id, [legacy])[0];
  assert.deepEqual(projected.agentMentions, []);
  assert.equal(projected.collaborationRecipients.length, 2);
  assert.equal(projected.text, event.text);
});
