import { describe, expect, it } from "vitest";
import {
  recipientMentionIdentities,
  resolveAgentMentionBindings,
} from "../src/mention-bindings.js";

describe("recipient mention bindings", () => {
  it("binds multiple send-time handles after recipients are renamed or deleted", () => {
    const recipientIds = ["agent-oak", "agent-pine"];
    const identities = recipientMentionIdentities(
      recipientIds,
      [{ id: "agent-oak", title: "Redwood" }],
      { "agent-oak": "Oak", "agent-pine": "Pine" },
    );

    expect(resolveAgentMentionBindings(
      "#Oak #Pine Private update",
      recipientIds,
      identities,
    )).toEqual([
      { handle: "Oak", agentId: "agent-oak" },
      { handle: "Pine", agentId: "agent-pine" },
    ]);
  });

  it("treats current and send-time names as aliases for one stable recipient", () => {
    const identities = recipientMentionIdentities(
      ["agent-oak"],
      [{ id: "agent-oak", title: "Redwood" }],
      { "agent-oak": "Oak" },
    );

    expect(resolveAgentMentionBindings(
      "#Oak Private update",
      ["agent-oak"],
      identities,
    )).toEqual([{ handle: "Oak", agentId: "agent-oak" }]);
    expect(resolveAgentMentionBindings(
      "#Redwood Follow-up",
      ["agent-oak"],
      identities,
    )).toEqual([{ handle: "Redwood", agentId: "agent-oak" }]);
  });
});
