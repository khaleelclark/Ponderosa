import { describe, expect, it } from "vitest";
import { projectAgentHealthQueries, projectAgentQueries, projectConversationQueries } from "../src/hooks/useProjectCollections";
import { queryKeys } from "../src/queryKeys";

const projects = [
  { id: "alpha", label: "Alpha", hostPath: "/alpha", defaultEngine: "codex" as const, createdAt: "2026-07-01T00:00:00.000Z" },
  { id: "beta", label: "Beta", hostPath: "/beta", defaultEngine: "codex" as const, createdAt: "2026-07-01T00:00:00.000Z" },
];

describe("canonical workspace query keys", () => {
  it("keeps collection prefixes invalidatable while scoping Project resources", () => {
    expect(queryKeys.agents.all).toEqual(["agents"]);
    expect(queryKeys.agents.project("alpha")).toEqual(["agents", "alpha"]);
    expect(queryKeys.conversations.project("alpha")).toEqual(["conversations", "alpha"]);
    expect(queryKeys.triggers.agent("agent-one")).toEqual(["triggers", "agent-one"]);
    expect(queryKeys.collaborationAll).toEqual(["collaboration-chat"]);
    expect(queryKeys.collaborationPrefix("chat-one")).toEqual(["collaboration-chat", "chat-one"]);
  });

  it("builds all repeated Project queries from the same factories", () => {
    expect(projectAgentQueries(projects).map((query) => query.queryKey)).toEqual([
      queryKeys.agents.project("alpha"),
      queryKeys.agents.project("beta"),
    ]);
    expect(projectConversationQueries(projects).map((query) => query.queryKey)).toEqual([
      queryKeys.conversations.project("alpha"),
      queryKeys.conversations.project("beta"),
    ]);
    expect(projectAgentHealthQueries(projects).map((query) => query.queryKey)).toEqual([
      queryKeys.agents.health("alpha"),
      queryKeys.agents.health("beta"),
    ]);
  });
});
