import assert from "node:assert/strict";
import test from "node:test";
import { routeToPath } from "../src/routeRegistry.js";
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
