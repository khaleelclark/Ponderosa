import { describe, expect, it } from "vitest";
import { communicationVisibleText } from "../src/components/chat/ChatMessages";

describe("communicationVisibleText", () => {
  it("removes operator and Agent Direct routing without changing ordinary text", () => {
    expect(communicationVisibleText({
      text: "#Oak #Pine Private update",
      intent: "user_dm",
      fromAgent: false,
      agentMentions: [{ handle: "Oak" }, { handle: "Pine" }],
    })).toBe("Private update");
    expect(communicationVisibleText({
      text: "#user Finished the review",
      intent: "user_dm",
      fromAgent: true,
    })).toBe("Finished the review");
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
});
