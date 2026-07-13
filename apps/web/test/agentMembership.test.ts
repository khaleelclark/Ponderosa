import { describe, expect, it } from "vitest";
import type { ThreadDto } from "@ponderosa/core";
import { agentBelongsToConversation } from "../src/agents";

describe("agent membership UI", () => {
  it("matches both home and secondary room filters", () => {
    const agent = { conversationId: "home", conversationIds: ["home", "review"] } as ThreadDto;
    expect(agentBelongsToConversation(agent, "home")).toBe(true);
    expect(agentBelongsToConversation(agent, "review")).toBe(true);
    expect(agentBelongsToConversation(agent, "other")).toBe(false);
  });
});
