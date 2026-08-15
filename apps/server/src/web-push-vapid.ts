import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createECDH, randomUUID, timingSafeEqual } from "node:crypto";
import webpush from "web-push";

const VAPID_DIRECTORY = "host-secrets";
const VAPID_FILE = "web-push-vapid.json";
const MAX_VAPID_FILE_BYTES = 16 * 1024;
const DEFAULT_VAPID_SUBJECT = "mailto:admin@localhost";

export interface WebPushVapidDetails {
  publicKey?: string;
  privateKey?: string;
  subject: string;
}

interface PersistedWebPushVapidDetails {
  version: 1;
  publicKey: string;
  privateKey: string;
}

export interface ResolvedWebPushVapid {
  vapid: WebPushVapidDetails;
  failure?: string;
}

function persistedVapidPath(dataDir: string): { directory: string; file: string } {
  const directory = path.join(dataDir, VAPID_DIRECTORY);
  return { directory, file: path.join(directory, VAPID_FILE) };
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) {
    throw new Error("the protected browser-push path is not a directory");
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPersistedVapid(file: string): PersistedWebPushVapidDetails {
  const metadata = lstatSync(file);
  if (!metadata.isFile()) throw new Error("the browser-push identity is not a regular file");
  if (metadata.size > MAX_VAPID_FILE_BYTES) throw new Error("the browser-push identity is unexpectedly large");
  if (process.platform !== "win32") chmodSync(file, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("the browser-push identity is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the browser-push identity has an invalid format");
  }
  const candidate = parsed as Partial<PersistedWebPushVapidDetails>;
  if (candidate.version !== 1 || typeof candidate.publicKey !== "string" ||
      typeof candidate.privateKey !== "string" || !candidate.publicKey.trim() ||
      !candidate.privateKey.trim()) {
    throw new Error("the browser-push identity is incomplete");
  }
  const persisted = {
    version: 1,
    publicKey: candidate.publicKey.trim(),
    privateKey: candidate.privateKey.trim(),
  } satisfies PersistedWebPushVapidDetails;
  validateMatchingVapidKeys(persisted.publicKey, persisted.privateKey);
  return persisted;
}

function validateMatchingVapidKeys(publicKey: string, privateKey: string): void {
  const publicKeyBytes = Buffer.from(publicKey, "base64url");
  const privateKeyBytes = Buffer.from(privateKey, "base64url");
  if (publicKeyBytes.byteLength !== 65 || privateKeyBytes.byteLength !== 32) {
    throw new Error("the browser-push identity has invalid key lengths");
  }
  let derivedPublicKey: Buffer;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateKeyBytes);
    derivedPublicKey = ecdh.getPublicKey(undefined, "uncompressed");
  } catch {
    throw new Error("the browser-push identity contains an invalid private key");
  }
  if (derivedPublicKey.byteLength !== publicKeyBytes.byteLength ||
      !timingSafeEqual(derivedPublicKey, publicKeyBytes)) {
    throw new Error("the browser-push public and private keys do not match");
  }
}

function currentVapidSubject(): string {
  const subject = process.env.PONDEROSA_VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;
  let parsed: URL;
  try {
    parsed = new URL(subject);
  } catch {
    throw new Error("the browser-push contact subject is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    throw new Error("the browser-push contact subject must use https: or mailto:");
  }
  return subject;
}

function publishGeneratedVapid(
  directory: string,
  file: string,
  generated: PersistedWebPushVapidDetails,
): PersistedWebPushVapidDetails {
  const temporary = path.join(directory, `.${VAPID_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, `${JSON.stringify(generated)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      // A hard link publishes the fully written inode without replacing an
      // identity another concurrent daemon may already have established.
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return readPersistedVapid(file);
    }
    if (process.platform !== "win32") chmodSync(file, 0o600);
    return generated;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    syncDirectory(directory);
  }
}

function loadOrCreatePersistedVapid(dataDir: string): PersistedWebPushVapidDetails {
  const { directory, file } = persistedVapidPath(dataDir);
  secureDirectory(directory);
  try {
    return readPersistedVapid(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const keys = webpush.generateVAPIDKeys();
  const generated = {
    version: 1,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  } satisfies PersistedWebPushVapidDetails;
  validateMatchingVapidKeys(generated.publicKey, generated.privateKey);
  return publishGeneratedVapid(directory, file, generated);
}

function failedResolution(subject: string, error: unknown): ResolvedWebPushVapid {
  const errorCode = (error as NodeJS.ErrnoException).code;
  const reason = errorCode === "EACCES" || errorCode === "EPERM"
    ? "access to the protected identity was denied"
    : errorCode === "ENOSPC"
      ? "the host has no storage space available"
      : errorCode === "EROFS"
        ? "the Ponderosa data directory is read-only"
        : error instanceof Error && error.message.startsWith("the ")
          ? error.message
          : "the protected identity could not be generated or loaded";
  return {
    vapid: { subject },
    failure: `Ponderosa could not activate its protected browser-push identity because ${reason}. Correct any VAPID environment overrides and check that the Ponderosa data directory is writable, then restart the Engine.`,
  };
}

/**
 * Resolve the host's stable Web Push identity. Explicit environment keys retain
 * precedence for operator-managed installations. Otherwise the server creates
 * one protected identity under the durable data root and reuses it forever.
 */
export function resolveWebPushVapid(dataDir: string): ResolvedWebPushVapid {
  const environmentPublicKey = process.env.PONDEROSA_VAPID_PUBLIC_KEY?.trim();
  const environmentPrivateKey = process.env.PONDEROSA_VAPID_PRIVATE_KEY?.trim();
  let subject: string;
  try {
    // The subject is runtime configuration rather than identity. Validate it
    // before any keypair is created or persisted so a typo remains recoverable.
    subject = currentVapidSubject();
  } catch (error) {
    return failedResolution(DEFAULT_VAPID_SUBJECT, error);
  }
  if (environmentPublicKey || environmentPrivateKey) {
    if (environmentPublicKey && environmentPrivateKey) {
      try {
        validateMatchingVapidKeys(environmentPublicKey, environmentPrivateKey);
      } catch (error) {
        return failedResolution(subject, error);
      }
    }
    return {
      vapid: {
        publicKey: environmentPublicKey,
        privateKey: environmentPrivateKey,
        subject,
      },
    };
  }

  try {
    const persisted = loadOrCreatePersistedVapid(dataDir);
    return {
      vapid: {
        publicKey: persisted.publicKey,
        privateKey: persisted.privateKey,
        subject,
      },
    };
  } catch (error) {
    return failedResolution(subject, error);
  }
}
