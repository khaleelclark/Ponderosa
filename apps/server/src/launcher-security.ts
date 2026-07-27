import { randomBytes } from "node:crypto";
import type { ReadinessDto } from "@ponderosa/core";
import type { CreateServerOptions } from "./app-contracts.js";

export function createLauncherSecurity(
  opts: CreateServerOptions,
) {

  const networkSecurity: ReadinessDto["networkSecurity"] = opts.networkSecurity ?? {
    mode: opts.authToken ? "authenticated" : "loopback",
    bindHost: "127.0.0.1",
    authenticationRequired: Boolean(opts.authToken),
    detail: opts.authToken
      ? "Operator API access requires bearer authentication on this loopback listener."
      : "Operator access is limited to clients on this host.",
  };
  const launcherNow = opts.launcherSecurity?.now ?? Date.now;
  const launcherRandomToken = opts.launcherSecurity?.randomToken ??
    (() => randomBytes(32).toString("base64url"));
  const launcherBootstrapTtlMs = Math.max(5_000, Math.min(
    opts.launcherSecurity?.bootstrapTtlMs ?? 60_000,
    5 * 60_000,
  ));
  const launcherSessionTtlMs = Math.max(60_000, Math.min(
    opts.launcherSecurity?.sessionTtlMs ?? 12 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
  ));
  const launcherBootstraps = new Map<string, number>();
  const launcherSessions = new Map<string, number>();
  const purgeLauncherSecurityState = (): void => {
    const now = launcherNow();
    for (const [token, expiresAt] of launcherBootstraps) {
      if (expiresAt <= now) launcherBootstraps.delete(token);
    }
    for (const [token, expiresAt] of launcherSessions) {
      if (expiresAt <= now) launcherSessions.delete(token);
    }
  };
  const cookieValue = (header: string | undefined, name: string): string | undefined =>
    header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const validLauncherSession = (header: string | undefined): boolean => {
    purgeLauncherSecurityState();
    const token = cookieValue(header, "ponderosa_session");
    return Boolean(token && (launcherSessions.get(token) ?? 0) > launcherNow());
  };
  return {
    networkSecurity,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    launcherSessions,
    purgeLauncherSecurityState,
    validLauncherSession,
  };
}
