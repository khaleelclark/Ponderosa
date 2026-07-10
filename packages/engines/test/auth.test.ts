import { describe, expect, it } from "vitest";
import { parseCodexLoginStatus } from "../src/auth.js";

describe("parseCodexLoginStatus", () => {
  it("accepts ChatGPT subscription auth", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT").authenticated).toBe(true);
  });

  it("rejects API-key or token auth even if the output mentions ChatGPT", () => {
    expect(
      parseCodexLoginStatus("Logged in using API key. Not using ChatGPT subscription.")
        .authenticated,
    ).toBe(false);
    expect(parseCodexLoginStatus("Logged in with access token").authenticated).toBe(false);
  });

  it("does not treat a negative ChatGPT status as authenticated", () => {
    expect(parseCodexLoginStatus("Not logged in using ChatGPT").authenticated).toBe(false);
  });

  it("does not treat generic ChatGPT help text as authenticated", () => {
    expect(parseCodexLoginStatus("Run codex login to use ChatGPT").authenticated).toBe(
      false,
    );
  });
});
