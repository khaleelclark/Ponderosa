import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { ReadinessDto } from "@ponderosa/core";
import type { CreateServerOptions } from "./app-contracts.js";

export function browserSessionCookie(
  session: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const name = secure ? "__Host-ponderosa_session" : "ponderosa_session";
  return `${name}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${
    secure ? "; Secure" : ""
  }`;
}

export function createLauncherSecurity(
  opts: CreateServerOptions,
  sqlite: Database.Database,
  now: () => number = Date.now,
) {

  const networkSecurity: ReadinessDto["networkSecurity"] = opts.networkSecurity ?? {
    mode: opts.authToken ? "authenticated" : "loopback",
    bindHost: "127.0.0.1",
    authenticationRequired: Boolean(opts.authToken),
    detail: opts.authToken
      ? "Operator API access requires bearer authentication on this loopback listener."
      : "Operator access is limited to clients on this host.",
  };
  const launcherNow = now;
  const launcherRandomToken = () => randomBytes(32).toString("base64url");
  const launcherBootstrapTtlMs = Math.max(5_000, Math.min(
    opts.launcherSecurity?.bootstrapTtlMs ?? 60_000,
    5 * 60_000,
  ));
  const launcherSessionTtlMs = Math.max(60_000, Math.min(
    opts.launcherSecurity?.sessionTtlMs ?? 30 * 24 * 60 * 60_000,
    90 * 24 * 60 * 60_000,
  ));
  const launcherBootstraps = new Map<string, number>();
  const browserSessionsEnabled = Boolean(
    opts.launcherSecurity || (networkSecurity.mode === "reverse_proxy" && opts.authToken),
  );
  // Rotating a reverse-proxy backend credential must revoke sessions issued
  // under the old credential, without tying installed local sessions to the
  // launcher control token that legitimately changes on restart.
  const credentialBinding = opts.authToken
    ? createHash("sha256").update(`backend:${opts.authToken}`).digest("hex")
    : "local_launcher";
  if (browserSessionsEnabled) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS launcher_browser_sessions (
        token_digest TEXT PRIMARY KEY,
        credential_binding TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS launcher_browser_sessions_expiry
        ON launcher_browser_sessions(expires_at_ms);
    `);
  }
  const tokenDigest = (token: string): string =>
    createHash("sha256").update(token).digest("hex");
  const purgeLauncherSecurityState = (): void => {
    const now = launcherNow();
    for (const [token, expiresAt] of launcherBootstraps) {
      if (expiresAt <= now) launcherBootstraps.delete(token);
    }
    if (browserSessionsEnabled) sqlite.prepare(
      "DELETE FROM launcher_browser_sessions WHERE expires_at_ms <= ?",
    ).run(now);
  };
  const issueLauncherSession = (): string => {
    if (!browserSessionsEnabled) throw new Error("browser sessions are disabled");
    purgeLauncherSecurityState();
    const token = launcherRandomToken();
    sqlite.prepare(
      "INSERT INTO launcher_browser_sessions(token_digest, credential_binding, expires_at_ms) VALUES(?, ?, ?)",
    ).run(tokenDigest(token), credentialBinding, launcherNow() + launcherSessionTtlMs);
    return token;
  };
  const cookieValue = (header: string | undefined, name: string): string | undefined =>
    header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const validLauncherSession = (
    header: string | undefined,
    onRenew?: (token: string, maxAgeSeconds: number) => void,
  ): boolean => {
    if (!browserSessionsEnabled) return false;
    const token = cookieValue(header, "__Host-ponderosa_session") ??
      cookieValue(header, "ponderosa_session");
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const digest = tokenDigest(token);
    const row = sqlite.prepare(
      "SELECT expires_at_ms AS expiresAt FROM launcher_browser_sessions WHERE token_digest = ? AND credential_binding = ?",
    ).get(digest, credentialBinding) as { expiresAt: number } | undefined;
    const current = launcherNow();
    if (!row || row.expiresAt <= current) return false;
    // Refresh the server record and HttpOnly cookie together. A session that
    // remains in use never expires mid-work, including across daemon restarts.
    if (onRenew && row.expiresAt - current <= launcherSessionTtlMs / 2) {
      sqlite.prepare(
        "UPDATE launcher_browser_sessions SET expires_at_ms = ? WHERE token_digest = ?",
      ).run(current + launcherSessionTtlMs, digest);
      onRenew(token, Math.floor(launcherSessionTtlMs / 1_000));
    }
    return true;
  };
  return {
    networkSecurity,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    issueLauncherSession,
    purgeLauncherSecurityState,
    validLauncherSession,
  };
}
