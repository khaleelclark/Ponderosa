import { describe, expect, it } from "vitest";
import { parseRoute, routeToPath, type Route } from "../src/routing";

describe("mobile-critical durable navigation", () => {
  it.each<Route>([
    { kind: "projects" },
    { kind: "allAgents" },
    { kind: "project", projectId: "project / one" },
    { kind: "conversation", projectId: "project / one", conversationId: "control room" },
    { kind: "conversation", projectId: "project / one", conversationId: "control room", focusMessageId: "event #1" },
    { kind: "agents", projectId: "project / one" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1" },
  ])("round-trips $kind URLs across refresh and browser history", (route) => {
    expect(parseRoute(routeToPath(route))).toEqual(route);
  });

  it("falls back safely for partial or unrelated paths", () => {
    expect(parseRoute("/projects/")).toEqual({ kind: "projects" });
    expect(parseRoute("/unrelated/path")).toEqual({ kind: "home" });
  });

  it("keeps global list routes distinct from project-scoped detail routes", () => {
    expect(routeToPath({ kind: "projects" })).toBe("/projects");
    expect(routeToPath({ kind: "allAgents" })).toBe("/agents");
    expect(parseRoute("/agents")).toEqual({ kind: "allAgents" });
  });

  it("uses the Project-chat URL vocabulary and rejects the retired route", () => {
    expect(routeToPath({ kind: "conversation", projectId: "project", conversationId: "planning" }))
      .toBe("/projects/project/chats/planning");
    expect(parseRoute("/projects/project/conversations/planning"))
      .toEqual({ kind: "project", projectId: "project" });
  });

  it("round-trips exact-message focus for Project and Agent chats", () => {
    const conversation: Route = { kind: "conversation", projectId: "project", conversationId: "planning", focusMessageId: "message / 1" };
    const agent: Route = { kind: "agent", projectId: "project", agentId: "agent", focusMessageId: "message #2" };
    expect(parseRoute(routeToPath(conversation))).toEqual(conversation);
    expect(parseRoute(routeToPath(agent))).toEqual(agent);
  });
});
