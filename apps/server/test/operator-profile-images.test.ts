import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOperatorProfileImage, storeOperatorProfileImage } from "../src/operator-profile-images.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ponderosa-profile-image-"));
  directories.push(directory);
  return directory;
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("managed Operator profile images", () => {
  it("publishes content-addressed image bytes durably and reads them after restart", async () => {
    const dataDir = fixture();
    const uploaded = await storeOperatorProfileImage(dataDir, png, "image/png");
    expect(uploaded).toMatchObject({ mediaType: "image/png", size: png.length });
    expect(uploaded.avatarId).toMatch(/^uploaded:png:[a-f0-9]{64}$/u);
    expect(await readOperatorProfileImage(dataDir, uploaded.avatarId)).toEqual({ body: png, mediaType: "image/png" });

    const duplicate = await storeOperatorProfileImage(dataDir, png, "image/png");
    expect(duplicate.avatarId).toBe(uploaded.avatarId);
  });

  it("rejects mismatched types and fails closed after managed bytes are altered", async () => {
    const dataDir = fixture();
    await expect(storeOperatorProfileImage(dataDir, png, "image/jpeg")).rejects.toThrow("do not match");
    const uploaded = await storeOperatorProfileImage(dataDir, png, "image/png");
    const [, kind, sha256] = uploaded.avatarId.split(":");
    writeFileSync(path.join(dataDir, "workspace", "profile-images", `${sha256}.${kind}`), "not an image");
    expect(await readOperatorProfileImage(dataDir, uploaded.avatarId)).toBeUndefined();
  });
});
