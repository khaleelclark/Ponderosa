import type { AgentDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentIdForMentionHandle, agentMentionHandle, findMentionedAgent, findMentionedAgents, findMentionedAgentsStrict, findMentionedHandles, hasEveryoneMention, stripCollaborationRoutingTags } from "../src/mentions";

const agent = (title: string): AgentDto => ({
  id: title,
  projectId: "project",
  conversationId: "master",
  title,
  activeEngine: "codex",
  state: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archived: false,
});

describe("agent mentions", () => {
  it("uses the agent's complete current display name", () => {
    expect(agentMentionHandle("  Bryce Agent  ")).toBe("Bryce-Agent");
    expect(findMentionedAgent("#Bryce-Agent take a look", [agent("Bryce Agent")])?.title).toBe("Bryce Agent");
  });

  it("uses a typeable canonical handle when a display name contains punctuation", () => {
    expect(agentMentionHandle("Wrangell-St. Elias")).toBe("Wrangell-St-Elias");
    expect(findMentionedAgent("#Wrangell-St-Elias please review", [agent("Wrangell-St. Elias")])?.title)
      .toBe("Wrangell-St. Elias");
  });

  it("recognizes hyphenated and Unicode names case-insensitively", () => {
    expect(findMentionedAgent("please ask #rivière-nord", [agent("Rivière-Nord")])?.title).toBe("Rivière-Nord");
  });

  it("requires a whitespace mention boundary", () => {
    const acadia = agent("Acadia");
    expect(findMentionedAgent(".#Acadia this is not a tag", [acadia])).toBeUndefined();
    expect(findMentionedAgent(".#Acadia, nor is this", [acadia])).toBeUndefined();
    expect(findMentionedAgent(". #Acadia this is a tag", [acadia])).toBe(acadia);
  });

  it("does not route a stale name after an agent is renamed", () => {
    const renamed = agent("Bryce");
    expect(findMentionedAgent("#Bryce status?", [renamed])).toBe(renamed);
    expect(findMentionedAgent("#OldName status?", [renamed])).toBeUndefined();
  });

  it("resolves every distinct agent mentioned in one message", () => {
    const bryce = agent("Bryce Canyon");
    const acadia = agent("Acadia");

    expect(findMentionedAgents("#Bryce-Canyon and #Acadia compare notes #Acadia", [bryce, acadia]))
      .toEqual([bryce, acadia]);
  });

  it("finds canonical handles without requiring a parent-chat update for every keystroke", () => {
    expect(findMentionedHandles("#bryce-canyon and #ACADIA #acadia", ["Bryce-Canyon", "Acadia"]))
      .toEqual(["Bryce-Canyon", "Acadia"]);
  });

  it("recognizes the reserved #everyone handle at a token boundary", () => {
    expect(hasEveryoneMention("#EVERYONE, please check in")).toBe(true);
    expect(hasEveryoneMention("email#everyone.example")).toBe(false);
    expect(hasEveryoneMention("#everyoneElse")).toBe(false);
  });

  it("does not treat #everyone as a direct-agent mention outside collaboration", () => {
    expect(findMentionedAgents("#everyone review", [agent("Bryce")])).toEqual([]);
  });

  it("reserves scope tags even when an agent has the same display name", () => {
    expect(findMentionedAgents("#broadcast context #user note #everyone update", [
      agent("Broadcast"), agent("User"), agent("Everyone"),
    ])).toEqual([]);
  });

  it("resolves rendered agent tags to stable IDs without linking scope tags", () => {
    expect(agentIdForMentionHandle([agent("Cabrillo")], "cAbRiLlO")).toBe("Cabrillo");
    expect(agentIdForMentionHandle([agent("User")], "user")).toBeUndefined();
  });

  it("fails closed when a routing handle maps to more than one stable agent", () => {
    const first = { ...agent("Reviewer"), id: "one" };
    const second = { ...agent("Reviewer"), id: "two" };
    expect(() => findMentionedAgentsStrict("#Reviewer inspect this", [first, second])).toThrow(/ambiguous/);
    expect(findMentionedAgentsStrict("#Reviewer inspect this", [first])).toEqual([first]);
  });

  it("strips routing tags before canonical labels are rendered", () => {
    expect(stripCollaborationRoutingTags("#Reviewer #everyone inspect this", [agent("Reviewer")])).toBe("inspect this");
  });
});
