import assert from "node:assert/strict";
import test from "node:test";
import {
  fixedCreateConversationMatchesProject,
  nestedProjectRouteResources,
  routeToPath,
  routeWaitsForWorkspacePreferences,
} from "../src/routeRegistry.js";
import { parseRoute, parseRouteLocation } from "../src/routing.js";

test("malformed encoded route segments fall back without throwing", () => {
  for (const path of [
    "/projects/%",
    "/projects/project-a/chats/%E0%A4%A",
    "/projects/project-a/agents/%ZZ",
    "/projects/project-a/automations/%E0%A4%A",
    "/projects/project-a/agents/agent-a/runs/%ZZ/browser",
  ]) {
    assert.deepEqual(parseRoute(path), { kind: "home" });
  }
});

test("encoded unicode route identities round trip", () => {
  const route = {
    kind: "conversation",
    projectId: "项目/one",
    conversationId: "café/two",
  };
  assert.deepEqual(parseRoute(routeToPath(route)), {
    ...route,
    urlDriven: true,
  });
});

test("initial and popstate-equivalent malformed locations request a stable URL", () => {
  for (const path of [
    "/projects/%",
    "/projects/project-a/chats/%ZZ",
  ]) {
    assert.deepEqual(parseRouteLocation(path), {
      route: { kind: "home" },
      replacement: "/",
    });
  }
  assert.deepEqual(parseRouteLocation("/projects/caf%C3%A9"), {
    route: { kind: "project", projectId: "café" },
  });
});

test("nested Project routes expose every resource that must match the Project", () => {
  assert.deepEqual(nestedProjectRouteResources({ kind: "agent", projectId: "a", agentId: "agent-b", view: "triggers", triggerId: "trigger-b" }), {
    agentId: "agent-b", triggerId: "trigger-b",
  });
  assert.deepEqual(nestedProjectRouteResources({ kind: "review", projectId: "a", agentId: "agent-b" }), { agentId: "agent-b" });
  assert.deepEqual(nestedProjectRouteResources({ kind: "conversation", projectId: "a", conversationId: "chat-b" }), { conversationId: "chat-b" });
  assert.deepEqual(nestedProjectRouteResources({ kind: "projectWork", projectId: "a", conversationId: "chat-b" }), { conversationId: "chat-b" });
  assert.deepEqual(nestedProjectRouteResources({ kind: "browser", projectId: "a", agentId: "agent-b", runId: "run-b", conversationId: "chat-b" }), {
    agentId: "agent-b", conversationId: "chat-b",
  });
  assert.deepEqual(nestedProjectRouteResources({ kind: "automation", projectId: "a", triggerId: "trigger-b" }), { triggerId: "trigger-b" });
});

test("a fixed create Chat must be live and owned by the selected Project", () => {
  const chat = { id: "chat-b", projectId: "project-b", archived: false };
  assert.equal(fixedCreateConversationMatchesProject("project-a", "chat-b", chat), false);
  assert.equal(fixedCreateConversationMatchesProject("project-b", "chat-b", chat), true);
  assert.equal(fixedCreateConversationMatchesProject("project-b", "chat-b", { ...chat, archived: true }), false);
  assert.equal(fixedCreateConversationMatchesProject("project-b", "chat-b", { ...chat, deletedAt: "2026-01-01T00:00:00.000Z" }), false);
  assert.equal(fixedCreateConversationMatchesProject("project-b", "chat-b", undefined), false);
});

test("editable preference routes cannot mount before canonical preferences hydrate", () => {
  const profile = { kind: "profile" };
  const settings = { kind: "settings" };
  assert.equal(routeWaitsForWorkspacePreferences(profile, false), true);
  assert.equal(routeWaitsForWorkspacePreferences(profile, true), false);
  assert.equal(routeWaitsForWorkspacePreferences(settings, false), true);
  assert.equal(routeWaitsForWorkspacePreferences(settings, true), false);
  assert.equal(routeWaitsForWorkspacePreferences({ kind: "home" }, false), false);
});
