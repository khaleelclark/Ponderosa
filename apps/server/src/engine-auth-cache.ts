import type { EngineAuthStatus } from "@ponderosa/core";

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

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string, load: () => Promise<EngineAuthStatus>): Promise<EngineAuthStatus> {
    const current = this.entries.get(id);
    const now = this.now();
    if (current?.value && current.expiresAt > now) return Promise.resolve(current.value);
    if (current?.pending) return current.pending;

    const pending = load().then(
      (value) => {
        this.entries.set(id, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      },
      (error) => {
        this.entries.delete(id);
        throw error;
      },
    );
    this.entries.set(id, { expiresAt: now, pending });
    return pending;
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }
}
