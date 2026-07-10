import type { ThreadDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { agentMentionHandle, findMentionedAgent } from "../src/mentions";

const thread = (title: string): ThreadDto => ({
  id: title,
  projectId: "project",
  masterChatId: "master",
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
    expect(findMentionedAgent("@Bryce-Agent take a look", [thread("Bryce Agent")])?.title).toBe("Bryce Agent");
  });

  it("recognizes hyphenated and Unicode names case-insensitively", () => {
    expect(findMentionedAgent("please ask @rivière-nord", [thread("Rivière-Nord")])?.title).toBe("Rivière-Nord");
  });

  it("does not route a stale name after an agent is renamed", () => {
    const renamed = thread("Bryce");
    expect(findMentionedAgent("@Bryce status?", [renamed])).toBe(renamed);
    expect(findMentionedAgent("@OldName status?", [renamed])).toBeUndefined();
  });
});
