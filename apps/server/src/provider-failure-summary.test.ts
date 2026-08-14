import { publicProviderFailureSummary } from "@ponderosa/core";
import { describe, expect, it } from "vitest";

describe("publicProviderFailureSummary", () => {
  it("rejects normalized restricted assignments regardless of spelling or value length", () => {
    const restricted = [
      String.raw`pa\u0073sword=hunter2`,
      String.raw`pa%73sword%3Dhunter2`,
      String.raw`password\u003dhunter2`,
      String.raw`pa\u200bssword=x`,
      "pass\u2063word=x",
      "pass\ufe0fword=x",
      "pa\u0301ssword=x",
      "paѕѕword=x",
      "SECRET_KEY=hunter2",
      "secret-key: 1",
      "runtime_client-secret=no",
      "AWS_ACCESS_KEY_ID=A",
    ];
    for (const detail of restricted) {
      expect(publicProviderFailureSummary(detail), detail).toBeUndefined();
    }
  });

  it("rejects short privileged and credential/config paths", () => {
    const restricted = [
      "/root",
      "/root/.aws/credentials",
      "/etc/shadow",
      "/etc/ssh",
      "/run/secrets",
      "/auth.json",
      "/",
      String.raw`C:\auth.json`,
      "./.config/gh",
      "../auth.json",
      "$HOME/.aws/credentials",
      "${HOME}/.codex/auth.json",
      String.raw`%HOME%\.aws\credentials`,
      "auth.json",
      "id_ed25519",
    ];
    for (const detail of restricted) {
      expect(publicProviderFailureSummary(detail), detail).toBeUndefined();
    }
  });

  it("boundedly decodes encoded JSON and fails closed for restricted or malformed content", () => {
    expect(publicProviderFailureSummary("eyJwYXNzd29yZCI6IngifQ==")).toBeUndefined();
    expect(publicProviderFailureSummary("eyJTRUNSRVRfS0VZIjoieCJ9")).toBeUndefined();
    expect(publicProviderFailureSummary("eyJtZXNzYWdlIjoicGFzc3dvcmQ9eCJ9")).toBeUndefined();
    expect(publicProviderFailureSummary("W3sicGFzc3dvcmQiOiJ4In1d")).toBeUndefined();
    expect(publicProviderFailureSummary("InBhc3N3b3JkPXgi")).toBeUndefined();
    expect(publicProviderFailureSummary("eyJwYXNzd29yZCI6")).toBeUndefined();
    expect(publicProviderFailureSummary(
      "eyJtZXNzYWdlIjoiY29ubmVjdGlvbiByZXNldCBieSBwZWVyIn0=",
    )).toBe("connection reset by peer");

    const nested = Buffer.from(JSON.stringify({
      message: "W3sicGFzc3dvcmQiOiJ4In1d",
    })).toString("base64");
    expect(publicProviderFailureSummary(nested)).toBeUndefined();

    let deep: unknown = { message: "ordinary detail" };
    for (let index = 0; index < 8; index += 1) deep = { message: deep };
    expect(publicProviderFailureSummary(
      Buffer.from(JSON.stringify(deep)).toString("base64"),
    )).toBeUndefined();
  });

  it("retains concise ordinary human failure detail", () => {
    expect(publicProviderFailureSummary("connection reset by peer")).toBe("connection reset by peer");
    expect(publicProviderFailureSummary("provider config unavailable")).toBe("provider config unavailable");
  });
});
