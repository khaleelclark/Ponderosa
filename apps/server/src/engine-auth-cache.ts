import type { EngineAuthStatus } from "@ponderosa/core";
import { projectProviderAuthStatus } from "./provider-success-projection.js";

interface CachedStatus {
  expiresAt: number;
  value?: EngineAuthStatus;
  pending?: Promise<EngineAuthStatus>;
  error?: unknown;
  observedAt?: number;
  lastKnown?: { authenticated: boolean; observedAt: number };
}

/**
 * Bounds expensive CLI-backed authentication probes and coalesces concurrent
 * readiness/API requests. A short TTL keeps login changes visible without
 * spawning a new CLI process for every health poll.
 */
export class EngineAuthStatusCache {
  private readonly entries = new Map<string, CachedStatus>();

  get(id: string, load: () => Promise<EngineAuthStatus>): Promise<EngineAuthStatus> {
    const current = this.entries.get(id);
    const now = Date.now();
    if (current?.value && current.expiresAt > now) return Promise.resolve(current.value);
    if (current?.pending) return current.pending;
    if (current?.error && current.expiresAt > now) return Promise.reject(current.error);

    const lastKnown = current?.lastKnown;
    const entry: CachedStatus = { expiresAt: now, ...(lastKnown ? { lastKnown } : {}) };
    const failed = (error: unknown): never => {
      if (this.entries.get(id) === entry) this.entries.set(id, { ...entry, pending: undefined, error, expiresAt: Date.now() + 5_000 });
      throw error;
    };
    const pending = Promise.resolve().then(load).then(
      (rawValue) => {
        let value: EngineAuthStatus;
        try {
          value = projectProviderAuthStatus(rawValue);
        } catch (error) {
          return failed(error);
        }
        if (this.entries.get(id) === entry) {
          const observedAt = Date.now();
          this.entries.set(id, { value, observedAt, expiresAt: observedAt + (value.status === "unknown" ? 5_000 : 30_000),
            ...(value.status === "unknown" ? lastKnown ? { lastKnown } : {} : { lastKnown: { authenticated: value.authenticated, observedAt } }) });
        }
        return value;
      },
      failed,
    );
    entry.pending = pending;
    this.entries.set(id, entry);
    return pending;
  }

  /** Read-only scheduling/read-model observation; never launches a probe. */
  snapshot(id: string): { state: "known" | "unknown"; authenticated?: boolean; observedAt?: string; lastKnown?: { authenticated: boolean; observedAt: string } } {
    const current = this.entries.get(id);
    const now = Date.now();
    if (current?.value && current.value.status !== "unknown" && current.expiresAt > now) {
      return { state: "known", authenticated: current.value.authenticated, observedAt: new Date(current.observedAt!).toISOString() };
    }
    const known = current?.lastKnown;
    return { state: "unknown", ...(known && now - known.observedAt <= 300_000
      ? { lastKnown: { authenticated: known.authenticated, observedAt: new Date(known.observedAt).toISOString() } } : {}) };
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }
}
