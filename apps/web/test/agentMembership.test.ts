import { describe, expect, it } from "vitest";
import type { ThreadDto } from "@ponderosa/core";
import { agentBelongsToMasterChat } from "../src/agents";

describe("agent membership UI", () => {
  it("matches both home and secondary room filters", () => {
    const agent = { masterChatId: "home", masterChatIds: ["home", "review"] } as ThreadDto;
    expect(agentBelongsToMasterChat(agent, "home")).toBe(true);
    expect(agentBelongsToMasterChat(agent, "review")).toBe(true);
    expect(agentBelongsToMasterChat(agent, "other")).toBe(false);
  });
});
