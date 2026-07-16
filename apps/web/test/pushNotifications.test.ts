import { describe, expect, it } from "vitest";
import type { WebPushStatusDto } from "@ponderosa/core";
import { classifyWebPushState } from "../src/pushNotifications";

const activeHost: WebPushStatusDto = { configured: true, configuration: "active", publicKey: "public" };

describe("actionable Web Push states", () => {
  it.each([
    [{ supported: false, secure: true, permission: "unsupported" as const }, undefined, false, "unsupported"],
    [{ supported: true, secure: false, permission: "default" as const }, undefined, false, "insecure_origin"],
    [{ supported: true, secure: true, permission: "default" as const }, activeHost, false, "permission_default"],
    [{ supported: true, secure: true, permission: "denied" as const }, activeHost, false, "permission_denied"],
    [{ supported: true, secure: true, permission: "granted" as const }, activeHost, true, "active"],
  ])("classifies browser/permission state as %s", (prerequisites, host, deviceActive, expected) => {
    expect(classifyWebPushState(prerequisites, host, deviceActive).kind).toBe(expected);
  });

  it("distinguishes missing host configuration and subscription failure", () => {
    const missing: WebPushStatusDto = {
      configured: false,
      configuration: "missing",
      detail: "Generate VAPID configuration.",
      setupCommand: "pnpm push:configure",
    };
    expect(classifyWebPushState({ supported: true, secure: true, permission: "default" }, missing)).toEqual({
      kind: "host_unconfigured",
      message: "Generate VAPID configuration.",
      setupCommand: "pnpm push:configure",
    });
    expect(classifyWebPushState({ supported: true, secure: true, permission: "granted" }, activeHost, false, "network unavailable")).toMatchObject({
      kind: "subscription_failed",
      message: expect.stringContaining("network unavailable"),
    });
  });
});
