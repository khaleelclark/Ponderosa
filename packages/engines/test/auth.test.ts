import { describe, expect, it } from "vitest";
import { claudeAvailabilityStatus, parseCodexLoginStatus } from "../src/auth.js";

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

describe("claudeAvailabilityStatus", () => {
  it("uses one explicit tool-free provider request as positive entitlement evidence", async () => {
    let args: string[] = [];
    const status = await claudeAvailabilityStatus(
      { PONDEROSA_CLAUDE_BIN: "claude-test" },
      async (_bin, received) => {
        args = received;
        return { stdout: '{"result":"PONDEROSA_RUNTIME_READY"}', stderr: "" };
      },
      async () => ({ authenticated: true, detail: "configured" }),
    );
    expect(status.available).toBe(true);
    expect(args).toEqual(expect.arrayContaining(["--tools", "", "--safe-mode", "--no-session-persistence"]));
  });

  it("does not call the provider when subscription authentication is absent", async () => {
    let called = false;
    const status = await claudeAvailabilityStatus(
      {},
      async () => {
        called = true;
        return { stdout: "", stderr: "" };
      },
      async () => ({ authenticated: false, detail: "sign in" }),
    );
    expect(status).toEqual({ available: false, detail: "sign in" });
    expect(called).toBe(false);
  });
});
