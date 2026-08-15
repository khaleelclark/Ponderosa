import type { EngineAuthStatus } from "@ponderosa/core";
import { projectProviderAuthStatus } from "./provider-success-projection.js";

interface CachedStatus {
  expiresAt: number;
  value?: EngineAuthStatus;
  pending?: Promise<EngineAuthStatus>;
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

    const entry: CachedStatus = { expiresAt: now };
    const pending = load().then(
      (rawValue) => {
        let value: EngineAuthStatus;
        try {
          value = projectProviderAuthStatus(rawValue);
        } catch (error) {
          if (this.entries.get(id) === entry) this.entries.delete(id);
          throw error;
        }
        if (this.entries.get(id) === entry) {
          this.entries.set(id, { value, expiresAt: Date.now() + 30_000 });
        }
        return value;
      },
      (error) => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        throw error;
      },
    );
    entry.pending = pending;
    this.entries.set(id, entry);
    return pending;
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }
}
