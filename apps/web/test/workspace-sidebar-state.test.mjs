import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSidebarSectionForRoute,
  routeClearsProjectSidebarContext,
} from "../src/routeRegistry.js";

test("Automation routes select the Project Automations sidebar", () => {
  assert.equal(
    projectSidebarSectionForRoute({
      kind: "automation",
      projectId: "project-a",
      triggerId: "automation-a",
    }),
    "triggers",
  );
});

test("synchronized global routes clear stale Project sidebar context", () => {
  for (const route of [
    { kind: "settings", section: "providers" },
    { kind: "settings" },
    { kind: "usage" },
  ]) {
    assert.equal(routeClearsProjectSidebarContext(route), true);
  }
  assert.equal(routeClearsProjectSidebarContext({ kind: "allAgents" }), false);
  assert.equal(
    routeClearsProjectSidebarContext({ kind: "project", projectId: "project-a" }),
    false,
  );
});
