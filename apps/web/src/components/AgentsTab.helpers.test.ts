import type { AgentDto, ConversationDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import {
  resolveAgentConversation,
  resolveAgentRelationshipParent,
} from "./AgentsTab.helpers";

function agent(
  id: string,
  overrides: Partial<AgentDto> = {},
): AgentDto {
  return {
    id,
    projectId: "project-1",
    conversationId: "chat-primary",
    conversationIds: ["chat-primary"],
    title: id,
    activeEngine: "codex",
    state: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    managementPermissions: {
      allowAutomaticDescendantDeletion: false,
      allowAutomaticDescendantReorganization: false,
    },
    ...overrides,
  };
}

function conversation(
  id: string,
  overrides: Partial<ConversationDto> = {},
): ConversationDto {
  return {
    id,
    projectId: "project-1",
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

describe("Agent relationship presentation", () => {
  it("resolves a manager outside the scoped Chat roster by stable Project Agent ID", () => {
    const manager = agent("manager");
    const child = agent("child", {
      managerAgentId: manager.id,
      conversationIds: ["chat-primary", "chat-secondary"],
    });

    expect(resolveAgentRelationshipParent(child, [manager, child])).toBe(manager);
    expect(resolveAgentRelationshipParent(child, [child])).toBeUndefined();
    expect(resolveAgentRelationshipParent(child, [
      agent("manager", { projectId: "project-2" }),
      child,
    ])).toBeUndefined();
  });

  it("uses the exact scoped membership Chat instead of the Agent primary Chat", () => {
    const child = agent("child", {
      conversationIds: ["chat-primary", "chat-secondary"],
    });
    const primary = conversation("chat-primary", { title: "Same title" });
    const secondary = conversation("chat-secondary", { title: "Same title" });

    expect(resolveAgentConversation(child, [secondary], secondary.id)).toBe(secondary);
    expect(resolveAgentConversation(child, [secondary, primary])).toBe(primary);
    expect(resolveAgentConversation(child, [secondary], "chat-decoy")).toBeUndefined();
    expect(resolveAgentConversation(child, [
      conversation("chat-secondary", { projectId: "project-2" }),
    ], secondary.id)).toBeUndefined();
  });
});
