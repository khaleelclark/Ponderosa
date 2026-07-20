import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { UploadedOperatorAvatarDto } from "@ponderosa/core";

const MAX_OPERATOR_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_ID = /^uploaded:(png|jpeg|webp):([a-f0-9]{64})$/u;
const MEDIA_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

type AvatarKind = keyof typeof MEDIA_TYPES;

export class OperatorProfileImageError extends Error {
  constructor(readonly statusCode: 400 | 413 | 415, message: string) {
    super(message);
    this.name = "OperatorProfileImageError";
  }
}

function imageKind(body: Buffer): AvatarKind | undefined {
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9) return "jpeg";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP" && body.readUInt32LE(4) + 8 === body.length) return "webp";
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
): Promise<UploadedOperatorAvatarDto> {
  if (body.length === 0) throw new OperatorProfileImageError(400, "profile image body is required");
  if (body.length > MAX_OPERATOR_AVATAR_BYTES) throw new OperatorProfileImageError(413, "profile image exceeds 2 MiB");
  const kind = imageKind(body);
  if (!kind || (kind === "png" && !validPng(body))) throw new OperatorProfileImageError(415, "profile image must be a valid PNG, JPEG, or WebP file");
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
): Promise<{ body: Buffer; mediaType: UploadedOperatorAvatarDto["mediaType"] } | undefined> {
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
