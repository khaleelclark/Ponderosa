import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_OPERATOR_AVATAR_BYTES, readOperatorProfileImage, storeOperatorProfileImage } from "../src/operator-profile-images.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ponderosa-profile-image-"));
  directories.push(directory);
  return directory;
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const box = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
};
const avif = Buffer.concat([
  box("ftyp", Buffer.concat([Buffer.from("avif"), Buffer.alloc(4), Buffer.from("avifmif1")])),
  box("meta", Buffer.alloc(4)),
  box("mdat", Buffer.from([0])),
]);

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

  it("accepts strict browser-safe GIF and AVIF containers and rejects SVG and HEIC", async () => {
    const dataDir = fixture();
    const uploadedGif = await storeOperatorProfileImage(dataDir, gif, "image/gif");
    const uploadedAvif = await storeOperatorProfileImage(dataDir, avif, "image/avif");
    expect(uploadedGif).toMatchObject({ mediaType: "image/gif", size: gif.length });
    expect(uploadedGif.avatarId).toMatch(/^uploaded:gif:[a-f0-9]{64}$/u);
    expect(uploadedAvif).toMatchObject({ mediaType: "image/avif", size: avif.length });
    expect(uploadedAvif.avatarId).toMatch(/^uploaded:avif:[a-f0-9]{64}$/u);
    await expect(storeOperatorProfileImage(dataDir, Buffer.concat([gif, Buffer.from([0])]), "image/gif")).rejects.toThrow("PNG, JPEG, WebP, GIF, or AVIF");
    await expect(storeOperatorProfileImage(dataDir, Buffer.concat([avif, Buffer.from([0])]), "image/avif")).rejects.toThrow("PNG, JPEG, WebP, GIF, or AVIF");
    await expect(storeOperatorProfileImage(dataDir, Buffer.from("<svg><script/></svg>"), "image/svg+xml")).rejects.toThrow("PNG, JPEG, WebP, GIF, or AVIF");
    const heic = Buffer.from(avif);
    heic.write("heic", 8, 4, "ascii");
    heic.write("heic", 16, 4, "ascii");
    await expect(storeOperatorProfileImage(dataDir, heic, "image/heic")).rejects.toThrow("PNG, JPEG, WebP, GIF, or AVIF");
  });

  it("parses at the documented 10 MiB boundary but rejects larger bodies first", async () => {
    const dataDir = fixture();
    expect(MAX_OPERATOR_AVATAR_BYTES).toBe(10 * 1024 * 1024);
    await expect(storeOperatorProfileImage(dataDir, Buffer.alloc(MAX_OPERATOR_AVATAR_BYTES), "image/png")).rejects.toThrow("must be a valid");
    await expect(storeOperatorProfileImage(dataDir, Buffer.alloc(MAX_OPERATOR_AVATAR_BYTES + 1), "image/png")).rejects.toThrow("exceeds 10 MiB");
  });
});
