import type { HealthDto } from "@ponderosa/core";
import { reloadBlockers } from "./reloadSafety";

const RELOAD_STATE_KEY = "ponderosa:service-worker-reload";
const MINIMUM_RELOAD_INTERVAL_MS = 15_000;
const BUILD_IDENTITY_TIMEOUT_MS = 5_000;
const BUILD_CONVERGENCE_WINDOW_MS = 2 * 60_000;
const BUILD_CONVERGENCE_RETRY_MS = 1_000;

interface ReloadState {
  buildIdentity: string;
  reloadedAt: number;
}

type ReloadDecision =
  | "reload_scheduled"
  | "same_build"
  | "reload_in_flight"
  | "recent_reload"
  | "missing_build_identity"
  | "unsafe_to_reload"
  | "storage_unavailable";

let installed = false;
let reloadDecisionInFlight = false;
let deferredReloadTimer: number | undefined;
let controllerChangedAt: number | undefined;

function withinBuildConvergenceWindow(): boolean {
  return controllerChangedAt !== undefined &&
    Date.now() - controllerChangedAt < BUILD_CONVERGENCE_WINDOW_MS;
}

function deferReloadDecision(delayMs: number): void {
  if (deferredReloadTimer !== undefined) return;
  deferredReloadTimer = window.setTimeout(() => {
    deferredReloadTimer = undefined;
    void reloadForNewController();
  }, delayMs);
}

function controllerUrl(): string | undefined {
  return navigator.serviceWorker.controller?.scriptURL;
}

function diagnostic(
  decision: ReloadDecision,
  detail: {
    previousBuildIdentity?: string;
    observedBuildIdentity?: string;
    retryAfterMs?: number;
    error?: unknown;
  } = {},
): void {
  const evidence = {
    decision,
    controllerUrl: controllerUrl(),
    ...detail,
  };
  if (decision === "missing_build_identity" || decision === "storage_unavailable") {
    console.warn("Ponderosa service-worker reload suppressed", evidence);
  } else if (decision === "reload_scheduled") {
    console.info("Ponderosa service-worker reload scheduled", evidence);
  } else {
    console.debug("Ponderosa service-worker reload suppressed", evidence);
  }
}

function sessionStorageAuthority(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch (error) {
    diagnostic("storage_unavailable", { error });
    return undefined;
  }
}

function readReloadState(storage: Storage): ReloadState | undefined {
  try {
    const encoded = storage.getItem(RELOAD_STATE_KEY);
    if (!encoded) return undefined;
    const candidate = JSON.parse(encoded) as Partial<ReloadState>;
    if (
      typeof candidate.buildIdentity !== "string" ||
      !candidate.buildIdentity ||
      typeof candidate.reloadedAt !== "number" ||
      !Number.isFinite(candidate.reloadedAt)
    ) {
      return undefined;
    }
    return {
      buildIdentity: candidate.buildIdentity,
      reloadedAt: candidate.reloadedAt,
    };
  } catch {
    return undefined;
  }
}

function writeReloadState(storage: Storage, state: ReloadState): boolean {
  try {
    storage.setItem(RELOAD_STATE_KEY, JSON.stringify(state));
    const persisted = readReloadState(storage);
    return persisted?.buildIdentity === state.buildIdentity &&
      persisted.reloadedAt === state.reloadedAt;
  } catch (error) {
    diagnostic("storage_unavailable", {
      observedBuildIdentity: state.buildIdentity,
      error,
    });
    return false;
  }
}

function normalizedBuildIdentity(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const health = candidate as Partial<HealthDto>;
  if (health.service !== "ponderosa") return undefined;
  const version = typeof health.version === "string" ? health.version.trim() : "";
  const revision = typeof health.revision === "string" ? health.revision.trim() : "";
  const usableVersion = version && version !== "0.0.0" && version.length <= 200
    ? version
    : undefined;
  const usableRevision = revision && revision !== "development" && revision.length <= 200
    ? revision
    : undefined;
  if (!usableVersion && !usableRevision) return undefined;
  return JSON.stringify([usableVersion ?? null, usableRevision ?? null]);
}

async function deployedBuildIdentity(): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BUILD_IDENTITY_TIMEOUT_MS);
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return normalizedBuildIdentity(await response.json());
  } finally {
    window.clearTimeout(timeout);
  }
}

async function reloadForNewController(): Promise<void> {
  if (reloadDecisionInFlight) {
    diagnostic("reload_in_flight");
    deferReloadDecision(250);
    return;
  }
  reloadDecisionInFlight = true;
  try {
    const storage = sessionStorageAuthority();
    if (!storage) return;
    const previous = readReloadState(storage);
    let observedBuildIdentity: string | undefined;
    try {
      observedBuildIdentity = await deployedBuildIdentity();
    } catch (error) {
      diagnostic("missing_build_identity", {
        previousBuildIdentity: previous?.buildIdentity,
        error,
      });
      if (withinBuildConvergenceWindow()) deferReloadDecision(BUILD_CONVERGENCE_RETRY_MS);
      return;
    }
    if (!observedBuildIdentity) {
      diagnostic("missing_build_identity", {
        previousBuildIdentity: previous?.buildIdentity,
      });
      if (withinBuildConvergenceWindow()) deferReloadDecision(BUILD_CONVERGENCE_RETRY_MS);
      return;
    }

    // Re-read after the network boundary so every decision uses the newest
    // durable state even if another lifecycle callback ran in the meantime.
    const current = readReloadState(storage);
    if (current?.buildIdentity === observedBuildIdentity) {
      diagnostic("same_build", {
        previousBuildIdentity: current.buildIdentity,
        observedBuildIdentity,
      });
      // A new worker can take control just before the reverse proxy switches
      // to the matching server. Retry for a bounded deploy window.
      if (withinBuildConvergenceWindow()) deferReloadDecision(BUILD_CONVERGENCE_RETRY_MS);
      return;
    }
    const blockers = reloadBlockers();
    if (blockers.length > 0) {
      diagnostic("unsafe_to_reload", {
        previousBuildIdentity: current?.buildIdentity,
        observedBuildIdentity,
        error: blockers.join(", "),
      });
      deferReloadDecision(BUILD_CONVERGENCE_RETRY_MS);
      return;
    }
    const now = Date.now();
    // A clock correction must not extend the fence until wall time catches
    // up. Same-build suppression above remains the durable loop boundary.
    const elapsedSinceReload = current && current.reloadedAt <= now
      ? now - current.reloadedAt
      : MINIMUM_RELOAD_INTERVAL_MS;
    if (current && elapsedSinceReload < MINIMUM_RELOAD_INTERVAL_MS) {
      const retryAfterMs = MINIMUM_RELOAD_INTERVAL_MS - elapsedSinceReload;
      diagnostic("recent_reload", {
        previousBuildIdentity: current.buildIdentity,
        observedBuildIdentity,
        retryAfterMs,
      });
      deferReloadDecision(retryAfterMs);
      return;
    }
    if (!writeReloadState(storage, { buildIdentity: observedBuildIdentity, reloadedAt: now })) {
      return;
    }
    diagnostic("reload_scheduled", {
      previousBuildIdentity: current?.buildIdentity,
      observedBuildIdentity,
    });
    if (deferredReloadTimer !== undefined) {
      window.clearTimeout(deferredReloadTimer);
      deferredReloadTimer = undefined;
    }
    window.location.reload();
  } finally {
    reloadDecisionInFlight = false;
  }
}

export function installServiceWorkerReloadGuard(): void {
  if (installed || !("serviceWorker" in navigator)) return;
  installed = true;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    controllerChangedAt = Date.now();
    void reloadForNewController();
  });
}
