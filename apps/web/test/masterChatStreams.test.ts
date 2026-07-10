import { describe, expect, it } from "vitest";
import { appendLiveReply, MAX_LIVE_REPLY_CHARS } from "../src/hooks/useMasterChatStreams";

describe("master chat live reply buffering", () => {
  it("retains only the newest 4,000 characters", () => {
    const result = appendLiveReply("a".repeat(MAX_LIVE_REPLY_CHARS), "ending");
    expect(result).toHaveLength(MAX_LIVE_REPLY_CHARS);
    expect(result.endsWith("ending")).toBe(true);
  });
});
