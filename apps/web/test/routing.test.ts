import { describe, expect, it } from "vitest";
import { parseRoute, routeToPath, type Route } from "../src/routing";

describe("mobile-critical durable navigation", () => {
  it.each<Route>([
    { kind: "projects" },
    { kind: "allChat" },
    { kind: "allChats" },
    { kind: "allChats", filterProjectId: "project / one" },
    { kind: "allAgents" },
    { kind: "allAgents", filterProjectId: "project / one" },
    { kind: "allTriggers" },
    { kind: "settings", section: "providers" },
    { kind: "profile" },
    { kind: "usage" },
    { kind: "usage", projectId: "project / one" },
    { kind: "wiki" },
    { kind: "wiki", articleId: "communication-scopes" },
    { kind: "project", projectId: "project / one" },
    { kind: "workspaceFile", projectId: "project / one", path: "docs/first look.md" },
    { kind: "browser", projectId: "project / one" },
    { kind: "browser", projectId: "project / one", agentId: "agent #1", runId: "run / 1" },
    { kind: "conversation", projectId: "project / one", conversationId: "control room" },
    { kind: "conversation", projectId: "project / one", conversationId: "control room", focusMessageId: "event #1" },
    { kind: "conversation", projectId: "project / one", conversationId: "control room", focusMessageId: "event #1", channel: "collaboration" },
    { kind: "projectWork", projectId: "project / one", conversationId: "control room", focusId: "request #1" },
    { kind: "agents", projectId: "project / one" },
    { kind: "agents", projectId: "project / one", create: true },
    { kind: "agents", projectId: "project / one", create: true, managerAgentId: "manager #1", continueToTrigger: true },
    { kind: "agent", projectId: "project / one", agentId: "agent #1" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1", view: "triggers" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1", view: "triggers", createTrigger: true },
    { kind: "agent", projectId: "project / one", agentId: "agent #1", view: "settings" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1", view: "technical" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1", view: "technical", technicalFocusId: "request #1" },
    { kind: "agent", projectId: "project / one", agentId: "agent #1", focusTelemetry: { stream: "activity", id: "agent #1:activity:7" } },
  ])("round-trips $kind URLs across refresh and browser history", (route) => {
    expect(parseRoute(routeToPath(route))).toEqual(route);
  });

  it("falls back safely for partial or unrelated paths", () => {
    expect(parseRoute("/projects/")).toEqual({ kind: "projects" });
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/unrelated/path")).toEqual({ kind: "home" });
  });

  it("keeps global list routes distinct from project-scoped detail routes", () => {
    expect(routeToPath({ kind: "projects" })).toBe("/projects");
    expect(routeToPath({ kind: "home" })).toBe("/");
    expect(routeToPath({ kind: "allChat" })).toBe("/messages");
    expect(parseRoute("/chats")).toEqual({ kind: "allChats" });
    expect(routeToPath({ kind: "allAgents" })).toBe("/agents");
    expect(parseRoute("/agents")).toEqual({ kind: "allAgents" });
    expect(routeToPath({ kind: "wiki", articleId: "project chat" })).toBe("/wiki/project%20chat");
  });

  it("deep-links Team Chat without conflating it with Project Chat", () => {
    const route: Route = {
      kind: "conversation", projectId: "project", conversationId: "planning",
      focusMessageId: "team-message", channel: "collaboration",
    };
    expect(routeToPath(route)).toBe("/projects/project/chats/planning?message=team-message&view=team");
    expect(parseRoute(routeToPath(route))).toEqual(route);
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

  it("keeps exact Technical Details focus durable in the Agent URL", () => {
    const route: Route = {
      kind: "agent",
      projectId: "project",
      agentId: "agent",
      view: "technical",
      technicalFocusId: "request:request / 1",
    };
    expect(routeToPath(route)).toBe("/projects/project/agents/agent?view=technical&focus=request%3Arequest+%2F+1");
    expect(parseRoute(routeToPath(route))).toEqual(route);
  });
});
