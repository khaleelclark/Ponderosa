import { describe, expect, it } from "vitest";
import {
  mobileCreationReturnRoute,
  mobileRouteAfterResourceRemoval,
} from "../src/App.mobile";

describe("mobile workspace navigation", () => {
  it("leaves a deleted current Agent for the Project Agent directory", () => {
    expect(
      mobileRouteAfterResourceRemoval(
        { kind: "agent", projectId: "project-1", agentId: "agent-1" },
        { kind: "agent", projectId: "project-1", agentId: "agent-1" },
      ),
    ).toEqual({ kind: "agents", projectId: "project-1" });
  });

  it("leaves any workspace owned by a deleted current Project", () => {
    expect(
      mobileRouteAfterResourceRemoval(
        { kind: "conversation", projectId: "project-1", conversationId: "chat-1" },
        { kind: "project", projectId: "project-1" },
      ),
    ).toEqual({ kind: "projects" });
  });

  it("does not navigate when a noncurrent resource is deleted", () => {
    expect(
      mobileRouteAfterResourceRemoval(
        { kind: "agent", projectId: "project-1", agentId: "agent-current" },
        { kind: "agent", projectId: "project-1", agentId: "agent-other" },
      ),
    ).toBeUndefined();
    expect(
      mobileRouteAfterResourceRemoval(
        { kind: "home" },
        { kind: "project", projectId: "project-1" },
      ),
    ).toBeUndefined();
  });

  it("returns to the explicit mobile creation origin or Home after refresh", () => {
    expect(
      mobileCreationReturnRoute({
        kind: "agent",
        projectId: "project-1",
        agentId: "agent-1",
      }),
    ).toEqual({
      kind: "agent",
      projectId: "project-1",
      agentId: "agent-1",
    });
    expect(mobileCreationReturnRoute()).toEqual({ kind: "home" });
  });
});
