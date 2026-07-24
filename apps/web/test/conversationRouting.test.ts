import { describe, expect, it } from "vitest";
import { managerBroadcastText, uploadFilesForRecipients } from "../src/conversationRouting.js";

describe("conversation routing helpers", () => {
  it("recognizes only a leading standalone #broadcast directive", () => {
    expect(managerBroadcastText("#broadcast release context")).toBe("release context");
    expect(managerBroadcastText("  #BROADCAST   release context  ")).toBe("release context");
    expect(managerBroadcastText("#broadcast")).toBe("");
    expect(managerBroadcastText("note #broadcast later")).toBeUndefined();
    expect(managerBroadcastText("#broadcasting later")).toBeUndefined();
  });

  it("uploads one attachment copy per Collaboration recipient and cleans all copies after a later failure", async () => {
    const files = [new File(["one"], "one.pdf")];
    const cleaned: string[] = [];
    await expect(uploadFilesForRecipients(
      ["agent-a", "agent-b"],
      files,
      async (agentId) => {
        if (agentId === "agent-b") throw new Error("second recipient failed");
        return { id: `${agentId}-asset` };
      },
      async (agentId, item) => { cleaned.push(`${agentId}:${item.id}`); },
    )).rejects.toThrow("second recipient failed");
    expect(cleaned).toEqual(["agent-a:agent-a-asset"]);
  });
});
