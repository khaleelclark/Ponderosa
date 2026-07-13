import { describe, expect, it } from "vitest";
import { managerBroadcastText, resolveConversationSendRoute, uploadDirectReplyFiles } from "../src/conversationReply.js";

describe("conversation Reply Directly routing", () => {
  it("recognizes only a leading standalone #broadcast directive", () => {
    expect(managerBroadcastText("#broadcast release context")).toBe("release context");
    expect(managerBroadcastText("  #BROADCAST   release context  ")).toBe("release context");
    expect(managerBroadcastText("#broadcast")).toBe("");
    expect(managerBroadcastText("note #broadcast later")).toBeUndefined();
    expect(managerBroadcastText("#broadcasting later")).toBeUndefined();
  });

  it("routes to exactly the locked author without a mention", () => {
    expect(resolveConversationSendRoute("author", [])).toEqual({ kind: "direct-reply", agentIds: ["author"] });
  });

  it("does not let typed mentions override the locked author", () => {
    expect(resolveConversationSendRoute("author", ["other"])).toEqual({ kind: "direct-reply", agentIds: ["author"] });
  });

  it("preserves normal mention and spawn routing", () => {
    expect(resolveConversationSendRoute(undefined, ["one", "two"])).toEqual({ kind: "mentioned-reply", agentIds: ["one", "two"] });
    expect(resolveConversationSendRoute(undefined, [])).toEqual({ kind: "spawn" });
  });

  it("cleans every successful staged upload when one direct-reply upload fails", async () => {
    const files = [new File(["one"], "one.png"), new File(["two"], "two.png")];
    const cleaned: string[] = [];
    await expect(uploadDirectReplyFiles(
      files,
      async (file) => {
        if (file.name === "two.png") throw new Error("upload failed");
        return { id: "asset-one" };
      },
      async (item) => { cleaned.push(item.id); },
    )).rejects.toThrow("upload failed");
    expect(cleaned).toEqual(["asset-one"]);
  });
});
