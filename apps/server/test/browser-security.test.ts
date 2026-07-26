import { describe, expect, it } from "vitest";
import {
  BrowserSessionError,
  initialBrowserTargetRequest,
  redactBrowserUrl,
  validateBrowserUrl,
} from "../src/browser-session-manager.js";

describe("browser navigation security", () => {
  it("accepts ordinary HTTP(S) URLs and rejects credentials or unsafe schemes", () => {
    expect(validateBrowserUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    expect(() => validateBrowserUrl("https://user:password@example.com"))
      .toThrowError(BrowserSessionError);
    expect(() => validateBrowserUrl("file:///etc/passwd"))
      .toThrowError("browser navigation accepts only http(s) URLs");
  });

  it("removes fragments while keeping benign URLs replayable", () => {
    expect(redactBrowserUrl("https://example.com/path?q=1#private")).toEqual({
      url: "https://example.com/path?q=1",
      replayUrl: "https://example.com/path?q=1",
    });
  });

  it.each([
    "token",
    "authorization_code",
    "x-amz-signature",
    "x-goog-credential",
    "clientsecret",
  ])("redacts and disables replay for the %s query parameter", (name) => {
    const redacted = redactBrowserUrl(
      `https://example.com/callback?${name}=sensitive&safe=value`,
    );
    expect(redacted.url).toContain(`${name}=%5BREDACTED%5D`);
    expect(redacted.url).toContain("safe=value");
    expect(redacted.replayUrl).toBeUndefined();
  });

  it("keeps the Chrome bootstrap target stable", () => {
    expect(initialBrowserTargetRequest()).toEqual({ url: "about:blank" });
  });
});
