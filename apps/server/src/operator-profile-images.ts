import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { validGif, validAvif } from "./image-containers.js";
import type { UploadedOperatorAvatarDto } from "@ponderosa/core";

export const MAX_OPERATOR_AVATAR_BYTES = 10 * 1024 * 1024;
export const OPERATOR_AVATAR_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"] as const;
const AVATAR_ID = /^uploaded:(png|jpeg|webp|gif|avif):([a-f0-9]{64})$/u;
const MEDIA_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
} as const;

type AvatarKind = keyof typeof MEDIA_TYPES;
type OperatorAvatarMediaType = typeof MEDIA_TYPES[AvatarKind];
type StoredOperatorAvatar = Omit<UploadedOperatorAvatarDto, "mediaType"> & { mediaType: OperatorAvatarMediaType };

export class OperatorProfileImageError extends Error {
  constructor(readonly statusCode: 400 | 413 | 415, message: string) {
    super(message);
    this.name = "OperatorProfileImageError";
  }
}

function imageKind(body: Buffer): AvatarKind | undefined {
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (validJpeg(body)) return "jpeg";
  if (validWebp(body)) return "webp";
  if (validGif(body)) return "gif";
  if (validAvif(body)) return "avif";
  return undefined;
}

function validPng(body: Buffer): boolean {
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= body.length) {
    const length = body.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > body.length) return false;
    const type = body.subarray(offset + 4, offset + 8).toString("ascii");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = body.readUInt32BE(offset + 8);
      const height = body.readUInt32BE(offset + 12);
      if (width === 0 || height === 0 || width > 4_096 || height > 4_096) return false;
      sawHeader = true;
    }
    offset = end;
    if (type === "IEND") return sawHeader && length === 0 && offset === body.length;
  }
  return false;
}

function validJpeg(body: Buffer): boolean {
  if (body.length < 8 || body[0] !== 0xff || body[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  while (offset < body.length) {
    if (body[offset] !== 0xff) return false;
    while (body[offset] === 0xff) offset += 1;
    const marker = body[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0xd9) return sawFrame && offset === body.length;
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) return false;
    if (offset + 2 > body.length) return false;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) return false;
    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    const frameMarker = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frameMarker) {
      if (length < 8) return false;
      const height = body.readUInt16BE(segmentStart + 1);
      const width = body.readUInt16BE(segmentStart + 3);
      if (width === 0 || height === 0 || width > 4_096 || height > 4_096) return false;
      sawFrame = true;
    }
    offset = segmentEnd;
    if (marker !== 0xda) continue;
    while (offset < body.length) {
      if (body[offset] !== 0xff) { offset += 1; continue; }
      const markerOffset = offset;
      while (body[offset] === 0xff) offset += 1;
      const scanMarker = body[offset];
      if (scanMarker === undefined) return false;
      if (scanMarker === 0x00 || scanMarker >= 0xd0 && scanMarker <= 0xd7) { offset += 1; continue; }
      offset = markerOffset;
      break;
    }
  }
  return false;
}

function validWebp(body: Buffer): boolean {
  if (body.length < 20 || body.subarray(0, 4).toString("ascii") !== "RIFF" ||
      body.subarray(8, 12).toString("ascii") !== "WEBP" || body.readUInt32LE(4) + 8 !== body.length) return false;
  let offset = 12;
  let extendedHeaders = 0;
  let bitstreamChunks = 0;
  let animationChunks = 0;
  while (offset + 8 <= body.length) {
    const type = body.subarray(offset, offset + 4).toString("ascii");
    const length = body.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > body.length || end + (length % 2) > body.length) return false;
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") {
      if (type === "VP8X") extendedHeaders += 1;
      else bitstreamChunks += 1;
      let width = 0;
      let height = 0;
      if (type === "VP8 ") {
        if (length < 10 || !body.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return false;
        width = body.readUInt16LE(start + 6) & 0x3fff;
        height = body.readUInt16LE(start + 8) & 0x3fff;
      } else if (type === "VP8L") {
        if (length < 5 || body[start] !== 0x2f) return false;
        const dimensions = body.readUInt32LE(start + 1);
        width = (dimensions & 0x3fff) + 1;
        height = ((dimensions >>> 14) & 0x3fff) + 1;
      } else {
        if (length < 10) return false;
        width = body.readUIntLE(start + 4, 3) + 1;
        height = body.readUIntLE(start + 7, 3) + 1;
      }
      if (width === 0 || height === 0 || width > 4_096 || height > 4_096) return false;
    }
    if (type === "ANIM") animationChunks += 1;
    offset = end + (length % 2);
  }
  return offset === body.length && extendedHeaders <= 1 && bitstreamChunks <= 1 && (
    extendedHeaders === 1 ? bitstreamChunks === 1 || animationChunks === 1 : bitstreamChunks === 1
  );
}


function root(dataDir: string): string {
  return path.join(dataDir, "workspace", "profile-images");
}

function parsedAvatar(avatarId: string): { kind: AvatarKind; sha256: string } | undefined {
  const match = AVATAR_ID.exec(avatarId);
  return match ? { kind: match[1] as AvatarKind, sha256: match[2]! } : undefined;
}

function avatarPath(dataDir: string, avatarId: string): string | undefined {
  const parsed = parsedAvatar(avatarId);
  return parsed ? path.join(root(dataDir), `${parsed.sha256}.${parsed.kind}`) : undefined;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureRoot(dataDir: string): Promise<string> {
  const workspaceDirectory = path.join(dataDir, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  const directory = root(dataDir);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    await syncDirectory(workspaceDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return directory;
}

export function isManagedOperatorAvatarId(avatarId: string): boolean {
  return AVATAR_ID.test(avatarId);
}

export async function storeOperatorProfileImage(
  dataDir: string,
  body: Buffer,
  declaredMediaType: string | undefined,
): Promise<StoredOperatorAvatar> {
  if (body.length === 0) throw new OperatorProfileImageError(400, "profile image body is required");
  if (body.length > MAX_OPERATOR_AVATAR_BYTES) throw new OperatorProfileImageError(413, "profile image exceeds 10 MiB");
  const kind = imageKind(body);
  if (!kind || (kind === "png" && !validPng(body))) throw new OperatorProfileImageError(415, "profile image must be a valid PNG, JPEG, WebP, GIF, or AVIF file");
  const mediaType = MEDIA_TYPES[kind];
  if (declaredMediaType?.split(";", 1)[0]?.trim().toLocaleLowerCase() !== mediaType) {
    throw new OperatorProfileImageError(415, `profile image bytes do not match ${declaredMediaType || "the declared media type"}`);
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const avatarId = `uploaded:${kind}:${sha256}`;
  const directory = await ensureRoot(dataDir);
  const destination = path.join(directory, `${sha256}.${kind}`);
  const temporary = path.join(directory, `.${sha256}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await fs.unlink(temporary);
    // The profile may reference this name only after its directory entry is durable.
    // Repeat the barrier for an idempotent retry whose earlier process may have
    // crashed after link publication but before acknowledging directory sync.
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  if (!await readOperatorProfileImage(dataDir, avatarId)) {
    throw new Error("managed profile image publication could not be revalidated");
  }
  return {
    avatarId,
    mediaType,
    size: body.length,
    url: `/api/workspace/profile-images/${encodeURIComponent(avatarId)}`,
  };
}

export async function readOperatorProfileImage(
  dataDir: string,
  avatarId: string,
): Promise<{ body: Buffer; mediaType: OperatorAvatarMediaType } | undefined> {
  const parsed = parsedAvatar(avatarId);
  const file = avatarPath(dataDir, avatarId);
  if (!parsed || !file) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OPERATOR_AVATAR_BYTES) return undefined;
    const body = await handle.readFile();
    if (createHash("sha256").update(body).digest("hex") !== parsed.sha256 || imageKind(body) !== parsed.kind || (parsed.kind === "png" && !validPng(body))) return undefined;
    return { body, mediaType: MEDIA_TYPES[parsed.kind] };
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
