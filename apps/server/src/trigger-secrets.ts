import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Host-local envelope encryption for durable webhook signing secrets. The key
 * is intentionally outside SQLite and written owner-only. */
export class TriggerSecretStore {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const keyPath = path.join(dataDir, "trigger-secrets.key");
    try {
      const keyStat = statSync(keyPath);
      if (!keyStat.isFile()) throw new Error("Automation secret encryption key must be a regular file");
      if (process.platform !== "win32" && (keyStat.mode & 0o077) !== 0) {
        throw new Error("Automation secret encryption key must be owner-only (0600)");
      }
      this.key = readFileSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = randomBytes(32);
      writeFileSync(keyPath, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32) throw new Error("invalid Automation secret encryption key");
  }

  create(): { secret: string; ciphertext: string; fingerprint: string } {
    const secret = randomBytes(32).toString("base64url");
    return { secret, ciphertext: this.encrypt(secret), fingerprint: this.fingerprint(secret) };
  }

  decrypt(encoded: string): string {
    const packed = Buffer.from(encoded, "base64url");
    if (packed.length < 29) throw new Error("invalid encrypted Automation secret");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  equal(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  private fingerprint(secret: string): string {
    return createHash("sha256").update(secret).digest("hex").slice(0, 12);
  }
}
