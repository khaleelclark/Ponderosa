import { describe, expect, it } from "vitest";
import { parseRoute, routeToPath, type Route } from "../src/routing";

describe("mobile-critical durable navigation", () => {
  it.each<Route>([
    { kind: "project", projectId: "project / one" },
    { kind: "conversation", projectId: "project / one", conversationId: "control room" },
    { kind: "agents", projectId: "project / one" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1" },
  ])("round-trips $kind URLs across refresh and browser history", (route) => {
    expect(parseRoute(routeToPath(route))).toEqual(route);
  });

  it("falls back safely for partial or unrelated paths", () => {
    expect(parseRoute("/projects")).toEqual({ kind: "home" });
    expect(parseRoute("/unrelated/path")).toEqual({ kind: "home" });
  });
});
