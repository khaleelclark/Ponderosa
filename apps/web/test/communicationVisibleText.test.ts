import { describe, expect, it } from "vitest";
import {
  authoredAgentMentionForHandle,
  communicationVisibleText,
  showBroadcastBadge,
} from "../src/components/chat/ChatMessages";

describe("communicationVisibleText", () => {
  it("keeps the authored label after its bound Agent is renamed or deleted", () => {
    const bindings = [
      { handle: "Oak", agentId: "agent-oak" },
      { handle: "Pine", agentId: "agent-pine" },
    ];

    expect(authoredAgentMentionForHandle("Oak", bindings)).toEqual({
      agentId: "agent-oak",
      label: "Oak",
    });
    expect(authoredAgentMentionForHandle("Pine", bindings)).toEqual({
      agentId: "agent-pine",
      label: "Pine",
    });
  });

  it("preserves Agent and operator Direct mentions for visible highlighting", () => {
    expect(communicationVisibleText({
      text: "#Oak #Pine Private update",
      intent: "user_dm",
      fromAgent: false,
      agentMentions: [{ handle: "Oak" }, { handle: "Pine" }],
    })).toBe("#Oak #Pine Private update");
    expect(communicationVisibleText({
      text: "#user Finished the review",
      intent: "user_dm",
      fromAgent: true,
    })).toBe("#user Finished the review");
    expect(communicationVisibleText({
      text: "Ordinary response",
      intent: "user_dm",
      fromAgent: true,
    })).toBe("Ordinary response");
  });

  it("shows one Broadcast scope treatment by removing its routing prefix", () => {
    expect(communicationVisibleText({
      text: "#broadcast Shared update",
      intent: "broadcast",
      fromAgent: false,
    })).toBe("Shared update");
  });

  it("reserves the Broadcast badge for non-opening broadcast events", () => {
    expect(showBroadcastBadge("broadcast", "broadcast-explicit")).toBe(true);
    expect(showBroadcastBadge("broadcast", "agent-opening:agent-one")).toBe(false);
    expect(showBroadcastBadge("user_dm", "direct-one")).toBe(false);
  });
});
