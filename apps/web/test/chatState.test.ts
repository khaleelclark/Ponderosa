import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStateKey, readChatState, readScrollPosition, writeChatState } from "../src/chatState";

const values = new Map<string, string>();

afterEach(() => {
  values.clear();
  vi.unstubAllGlobals();
});

function installStorage(): void {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
}

describe("persistent chat state", () => {
  it("names state by surface and durable scope", () => {
    expect(chatStateKey("draft", "agent-1")).toBe("ponderosa.chat.v1.draft.agent-1");
  });

  it("round-trips drafts and removes empty values", () => {
    installStorage();
    writeChatState("draft", "keep my draft");
    expect(readChatState("draft")).toBe("keep my draft");
    writeChatState("draft", "");
    expect(readChatState("draft")).toBeUndefined();
  });

  it("accepts only finite non-negative scroll positions", () => {
    installStorage();
    writeChatState("scroll", "142.5");
    expect(readScrollPosition("scroll")).toBe(142.5);
    writeChatState("scroll", "not-a-number");
    expect(readScrollPosition("scroll")).toBeUndefined();
  });

  it("fails closed when browser storage is unavailable", () => {
    expect(readChatState("missing")).toBeUndefined();
    expect(() => writeChatState("missing", "value")).not.toThrow();
  });
});
