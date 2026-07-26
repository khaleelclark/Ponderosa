import type {
  Adapter,
  ProviderUsage,
  ProviderUsageStateDto,
  RuntimeProcessHandle,
} from "@ponderosa/core";

const DEFAULT_STALE_MS = 5 * 60_000;

interface ProviderUsageCacheEntry {
  provider: string;
  accountKey: string;
  reading?: ProviderUsage;
  error?: string;
  lastStartedAt?: number;
  operation?: Promise<void>;
  authority?: ProviderUsageAuthority;
}

interface ProviderUsageAuthority {
  controller: AbortController;
  processes: Set<RuntimeProcessHandle>;
}

export interface ProviderUsageTarget {
  adapter: Adapter;
  displayName: string;
  authenticated: boolean;
  /** Stable identity from the provider auth projection; prevents cross-account cache reuse. */
  accountKey: string;
  /** Human account identity used only when the provider result omits one. */
  accountLabel?: string;
}

export class ProviderUsageCache {
  private readonly entries = new Map<string, ProviderUsageCacheEntry>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly staleMs = DEFAULT_STALE_MS,
    private readonly timeoutMs = 15_000,
  ) {}

  state(target: ProviderUsageTarget): ProviderUsageStateDto {
    const entry = this.entries.get(this.key(target));
    const reading = entry?.reading
      ? {
          ...entry.reading,
          ...(!entry.reading.accountLabel && target.accountLabel
            ? { accountLabel: target.accountLabel }
            : {}),
          ...(this.isStale(entry) || entry.error ? { stale: true } : {}),
        }
      : undefined;
    return {
      provider: target.adapter.id,
      displayName: target.displayName,
      authenticated: target.authenticated,
      ...(reading ? { reading } : {}),
      refreshing: Boolean(entry?.operation),
      ...(entry?.error ? { error: entry.error } : {}),
    };
  }

  /** Start a refresh and return immediately. Automatic callers respect the
   * five-minute floor; explicit manual refreshes may bypass it. */
  refresh(target: ProviderUsageTarget, force = false): ProviderUsageStateDto {
    const state = this.state(target);
    if (this.closed || !target.authenticated || !target.adapter.readProviderUsage) return state;
    const key = this.key(target);
    const entry = this.entries.get(key) ?? {
      provider: target.adapter.id,
      accountKey: target.accountKey,
    };
    this.entries.set(key, entry);
    if (entry.operation) return this.state(target);
    if (!force && !this.isStale(entry)) return this.state(target);

    const authority: ProviderUsageAuthority = {
      controller: new AbortController(),
      processes: new Set(),
    };
    entry.authority = authority;
    entry.lastStartedAt = Date.now();
    const operation = Promise.resolve()
      .then(() => target.adapter.readProviderUsage!({
        cwd: this.cwd,
        signal: authority.controller.signal,
        timeoutMs: this.timeoutMs,
        onRuntimeSpawned: (handle) => {
          authority.processes.add(handle);
          if (this.closed || authority.controller.signal.aborted) {
            void handle.close().catch(() => undefined);
          }
        },
      }))
      .then((reading) => {
        if (reading.provider !== target.adapter.id) {
          throw new Error(`${target.adapter.id} usage reader returned ${reading.provider}`);
        }
        entry.reading = {
          ...reading,
          ...(!reading.accountLabel && target.accountLabel
            ? { accountLabel: target.accountLabel }
            : {}),
        };
        entry.error = undefined;
      })
      .catch((error: unknown) => {
        if (!this.closed) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(async () => {
        authority.controller.abort();
        const cleanup = await Promise.allSettled(
          [...authority.processes].map((handle) => handle.close()),
        );
        const failure = cleanup.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          entry.error = failure.reason instanceof Error
            ? failure.reason.message
            : String(failure.reason);
        } else {
          authority.processes.clear();
          if (entry.authority === authority) entry.authority = undefined;
        }
        if (entry.operation === operation) entry.operation = undefined;
      });
    entry.operation = operation;
    return this.state(target);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    for (const entry of entries) entry.authority?.controller.abort();
    await Promise.allSettled(entries.flatMap((entry) => entry.operation ? [entry.operation] : []));
    const cleanup = await Promise.allSettled(entries.flatMap((entry) =>
      [...(entry.authority?.processes ?? [])].map((handle) => handle.close())
    ));
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length) {
      throw new AggregateError(failures, "Provider usage processes did not terminate");
    }
  }

  pendingCount(): number {
    return [...this.entries.values()].filter((entry) =>
      Boolean(entry.operation || entry.authority?.processes.size)
    ).length;
  }

  private key(target: ProviderUsageTarget): string {
    return `${target.adapter.id}\0${target.accountKey}`;
  }

  private isStale(entry: ProviderUsageCacheEntry | undefined): boolean {
    if (!entry?.lastStartedAt) return true;
    return Date.now() - entry.lastStartedAt >= this.staleMs;
  }
}
