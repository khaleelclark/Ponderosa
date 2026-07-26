import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/app.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-push-status-"));
  dirs.push(dir);
  return dir;
}

describe("Web Push host and device status", () => {
  it("reports actionable missing and invalid host configuration without key material", async () => {
    const missing = createServer({ dataDir: dataDir(), engines: [], logger: false, webPush: { publicKey: "", privateKey: "" } });
    expect((await missing.inject("/api/push/status")).json()).toMatchObject({
      configured: false,
      configuration: "missing",
      setupCommand: expect.stringContaining("push:configure"),
    });
    await missing.close();

    const invalid = createServer({ dataDir: dataDir(), engines: [], logger: false, webPush: { publicKey: "only-public", privateKey: "" } });
    const response = (await invalid.inject("/api/push/status")).json();
    expect(response).toMatchObject({ configured: false, configuration: "invalid" });
    expect(JSON.stringify(response)).not.toContain("only-public");
    await invalid.close();
  });

  it("reports an active device and makes reconnect upserts idempotent", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createServer({
      dataDir: dataDir(),
      engines: [],
      logger: false,
      webPush: { publicKey: "test-public", privateKey: "test-private", sender: { send } },
    });
    const body = {
      deviceId: "phone",
      endpoint: "https://push.example/device",
      expirationTime: null,
      keys: { p256dh: "key", auth: "auth" },
      updatedAt: new Date().toISOString(),
    };
    expect((await app.inject({ method: "PUT", url: "/api/push/subscriptions/phone", payload: body })).statusCode).toBe(204);
    expect((await app.inject({ method: "PUT", url: "/api/push/subscriptions/phone", payload: body })).statusCode).toBe(204);
    expect((await app.inject("/api/push/status?deviceId=phone")).json()).toMatchObject({
      configured: true,
      configuration: "active",
      publicKey: "test-public",
      deviceRegistered: true,
    });
    await app.close();
  });
});
