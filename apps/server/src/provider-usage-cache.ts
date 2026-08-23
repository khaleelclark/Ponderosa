import { randomUUID } from "node:crypto";
import {
  type Adapter,
  type ProviderUsage,
  ProviderUsageReadError,
  type ProviderUsageFailureCode,
  type ProviderUsageFailureDto,
  type ProviderUsageStateDto,
  type RuntimeProcessHandle,
} from "@ponderosa/core";
import { projectProviderUsage } from "./provider-success-projection.js";
import { providerProcessHandleFacade } from "./provider-session-facade.js";

const DEFAULT_STALE_MS = 5 * 60_000;

interface ProviderUsageCacheEntry {
  provider: string;
  accountKey: string;
  reading?: ProviderUsage;
  failure?: ProviderUsageFailureDto;
  authority?: ProviderUsageAuthority;
}

interface ProviderUsageAuthority {
  provider: string;
  controller: AbortController;
  processes: Set<RuntimeProcessHandle>;
  cleanupReported?: boolean;
}

interface ProviderUsageOperation {
  generation: number;
  authority: ProviderUsageAuthority;
  promise: Promise<void>;
  observedAccountKey?: string;
}

const FAILURE_MESSAGES: Record<ProviderUsageFailureCode, string> = {
  provider_not_installed: "This provider is not installed on the Ponderosa host.",
  provider_not_authenticated: "Sign in to this provider on the Ponderosa host.",
  provider_disabled: "This provider is disabled in Ponderosa settings.",
  usage_not_supported: "This installed provider version does not expose subscription usage.",
  command_timeout: "Subscription usage retrieval timed out.",
  invalid_provider_response: "The provider returned an unrecognized usage response.",
  provider_rate_limited: "The provider rate-limited the usage request.",
  provider_temporarily_unavailable: "Subscription usage is temporarily unavailable.",
  server_environment_invalid: "The Ponderosa host environment cannot retrieve provider usage.",
  unknown_failure: "Subscription usage could not be retrieved.",
};

export interface ProviderUsageFailureEvent {
  event: "provider_usage_retrieval_failed";
  provider: string;
  failureCode: ProviderUsageFailureCode;
  durationMs: number;
  runtimeVersion: string;
  exitCode?: number;
  timedOut: boolean;
  cachedReturned: boolean;
  correlationId: string;
}

function failureDto(
  code: ProviderUsageFailureCode,
  metadata: {
    durationMs?: number;
    exitCode?: number;
    timedOut?: boolean;
    runtimeVersion?: string;
    correlationId?: string;
  } = {},
): ProviderUsageFailureDto {
  return {
    code,
    message: FAILURE_MESSAGES[code],
    correlationId: metadata.correlationId ?? randomUUID(),
    occurredAt: new Date().toISOString(),
    ...(metadata.durationMs === undefined ? {} : { durationMs: metadata.durationMs }),
    ...(metadata.exitCode === undefined ? {} : { exitCode: metadata.exitCode }),
    ...(metadata.timedOut === undefined ? {} : { timedOut: metadata.timedOut }),
    ...(metadata.runtimeVersion ? { runtimeVersion: metadata.runtimeVersion } : {}),
  };
}

function classifiedFailure(error: unknown, durationMs: number): ProviderUsageFailureDto {
  if (error instanceof ProviderUsageReadError) {
    return failureDto(error.code, { durationMs, ...error.metadata });
  }
  return failureDto("unknown_failure", { durationMs });
}

export interface ProviderUsageTarget {
  adapter: Adapter;
  displayName: string;
  enabled: boolean;
  authenticated: boolean;
  /** Stable identity from the provider auth projection; prevents cross-account cache reuse. */
  accountKey: string;
  /** Human account identity used only when the provider result omits one. */
  accountLabel?: string;
}

export class ProviderUsageCache {
  private readonly entries = new Map<string, ProviderUsageCacheEntry>();
  private readonly operations = new Map<string, ProviderUsageOperation>();
  private readonly activeAccounts = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly lastStartedAt = new Map<string, number>();
  private readonly liveAuthorities = new Set<ProviderUsageAuthority>();
  private readonly cleanupTimers = new Map<ProviderUsageAuthority, NodeJS.Timeout>();
  private readonly cleanupInFlight = new Map<ProviderUsageAuthority, Promise<void>>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly staleMs = DEFAULT_STALE_MS,
    private readonly timeoutMs = 15_000,
    private readonly registerProcess?: (handle: RuntimeProcessHandle, providerId: string) => void,
    private readonly reportFailure?: (event: ProviderUsageFailureEvent) => void,
  ) {}

  state(target: ProviderUsageTarget): ProviderUsageStateDto {
    const staticFailureCode: ProviderUsageFailureCode | undefined = !target.enabled
      ? "provider_disabled"
      : !target.authenticated
      ? "provider_not_authenticated"
      : !target.adapter.readProviderUsage && !target.adapter.readProviderUsageSnapshot
      ? "usage_not_supported"
      : undefined;
    const operation = this.operations.get(target.adapter.id);
    const base = {
      provider: target.adapter.id,
      displayName: target.displayName,
      authenticated: target.authenticated,
      refreshing: Boolean(operation),
    };
    if (staticFailureCode) {
      return {
        ...base,
        refreshing: false,
        status: "unavailable",
        failure: failureDto(staticFailureCode),
      };
    }
    const entry = target.adapter.readProviderUsageSnapshot
      ? operation && !operation.observedAccountKey
        ? undefined
        : this.activeEntry(target.adapter.id)
      : this.entryFor(target);
    let invalidReading = false;
    let projectedReading: ProviderUsage | undefined;
    if (entry?.reading) {
      try {
        projectedReading = projectProviderUsage(entry.reading, target.adapter.id);
      } catch {
        invalidReading = true;
      }
    }
    if (invalidReading && entry) {
      entry.failure = failureDto("invalid_provider_response");
    }
    const data = projectedReading
      ? {
          ...projectedReading,
          ...(!projectedReading.accountLabel && target.accountLabel
            ? { accountLabel: target.accountLabel }
            : {}),
        }
      : undefined;
    if (data && entry?.failure) {
      return {
        ...base,
        status: "stale",
        data: { ...data, stale: true },
        retrievedAt: data.fetchedAt,
        failure: entry.failure,
      };
    }
    if (data) {
      return { ...base, status: "fresh", data, retrievedAt: data.fetchedAt };
    }
    return {
      ...base,
      status: "unavailable",
      failure: entry?.failure ?? failureDto("unknown_failure"),
    };
  }

  /** Start a refresh and return immediately. Automatic callers respect the
   * five-minute floor; explicit manual refreshes may bypass it. */
  refresh(target: ProviderUsageTarget, force = false): ProviderUsageStateDto {
    const state = this.state(target);
    if (
      this.closed
      || !target.enabled
      || !target.authenticated
      || (!target.adapter.readProviderUsage && !target.adapter.readProviderUsageSnapshot)
    ) return state;
    const key = target.adapter.id;
    const existing = this.operations.get(key);
    // Manual refresh bypasses the freshness floor, not the single-flight
    // contract. Every concurrent caller joins the authoritative operation.
    if (existing) return this.state(target);
    if (!force && !this.isStale(key)) return this.state(target);

    const authority: ProviderUsageAuthority = {
      provider: key,
      controller: new AbortController(),
      processes: new Set(),
    };
    this.liveAuthorities.add(authority);
    this.lastStartedAt.set(key, Date.now());
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const startedAt = Date.now();
    let observedIdentity: { fingerprint: string; accountLabel?: string } | undefined;
    const observeIdentity = (
      identity: { fingerprint: string; accountLabel?: string } | undefined,
    ): void => {
      if (
        this.generations.get(key) !== generation
        || this.operations.get(key)?.generation !== generation
      ) return;
      const currentOperation = this.operations.get(key);
      if (!identity) {
        observedIdentity = undefined;
        if (currentOperation) currentOperation.observedAccountKey = undefined;
        this.bindAccount(key, target.accountKey);
        this.entryForAccount(key, target.accountKey);
        this.activeAccounts.set(key, target.accountKey);
        return;
      }
      observedIdentity = identity;
      if (currentOperation) currentOperation.observedAccountKey = identity.fingerprint;
      this.bindAccount(key, identity.fingerprint);
      this.entryForAccount(key, identity.fingerprint);
      this.activeAccounts.set(key, identity.fingerprint);
    };
    const operation = Promise.resolve()
      .then(async () => {
        const options = {
          cwd: this.cwd,
          signal: authority.controller.signal,
          timeoutMs: this.timeoutMs,
          onRuntimeSpawned: (handle: RuntimeProcessHandle) => {
            handle = providerProcessHandleFacade(handle);
            authority.processes.add(handle);
            this.registerProcess?.(handle, target.adapter.id);
            if (this.closed || authority.controller.signal.aborted) {
              void handle.close().catch(() => undefined);
            }
          },
          onAccountIdentity: observeIdentity,
        };
        if (target.adapter.readProviderUsageSnapshot) {
          return target.adapter.readProviderUsageSnapshot(options);
        }
        return {
          identity: {
            fingerprint: target.accountKey,
            ...(target.accountLabel ? { accountLabel: target.accountLabel } : {}),
          },
          usage: await target.adapter.readProviderUsage!(options),
        };
      })
      .then(({ identity, usage }) => {
        if (
          this.generations.get(key) !== generation
          || this.operations.get(key)?.generation !== generation
        ) return;
        observeIdentity(identity);
        const committedEntry = this.entryForAccount(key, identity.fingerprint);
        committedEntry.authority = authority;
        this.activeAccounts.set(key, identity.fingerprint);
        const reading = usage;
        const projected = projectProviderUsage(reading, target.adapter.id);
        committedEntry.reading = {
          ...projected,
          ...(!projected.accountLabel && identity.accountLabel
            ? { accountLabel: identity.accountLabel }
            : {}),
        };
        committedEntry.failure = undefined;
      })
      .catch((error: unknown) => {
        if (
          !this.closed
          && this.generations.get(key) === generation
          && this.operations.get(key)?.generation === generation
        ) {
          const durationMs = Date.now() - startedAt;
          const failure = classifiedFailure(error, durationMs);
          if (target.adapter.readProviderUsageSnapshot && !observedIdentity) {
            // If account ownership could not be established, fence the prior
            // provider-owned reading instead of risking cross-account reuse.
            this.bindAccount(key, target.accountKey);
            this.entryForAccount(key, target.accountKey);
            this.activeAccounts.set(key, target.accountKey);
          }
          const failedEntry = observedIdentity
            ? this.entryForAccount(key, observedIdentity.fingerprint)
            : this.activeEntry(key) ?? this.entryFor(target);
          failedEntry.failure = failure;
          this.reportFailure?.({
            event: "provider_usage_retrieval_failed",
            provider: target.adapter.id,
            failureCode: failure.code,
            durationMs,
            runtimeVersion: failure.runtimeVersion ?? "unknown",
            ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
            timedOut: failure.timedOut ?? false,
            cachedReturned: Boolean(failedEntry.reading),
            correlationId: failure.correlationId,
          });
        }
      })
      .finally(async () => {
        authority.controller.abort();
        await this.cleanupAuthority(authority, true, startedAt);
        for (const cachedEntry of this.entries.values()) {
          if (cachedEntry.authority === authority && !authority.processes.size) {
            cachedEntry.authority = undefined;
          }
        }
        if (this.operations.get(key)?.promise === operation) this.operations.delete(key);
      });
    this.operations.set(key, { generation, authority, promise: operation });
    return this.state(target);
  }

  bindAccount(provider: string, accountKey: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.provider === provider && entry.accountKey !== accountKey) {
        entry.authority?.controller.abort();
        this.entries.delete(key);
      }
    }
  }

  invalidateUnavailable(provider: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.provider === provider) {
        entry.authority?.controller.abort();
        this.entries.delete(key);
      }
    }
    const operation = this.operations.get(provider);
    operation?.authority.controller.abort();
    this.activeAccounts.delete(provider);
    this.lastStartedAt.delete(provider);
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    for (const authority of this.liveAuthorities) authority.controller.abort();
    await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise));
    for (let attempt = 0; attempt < 3 && this.liveAuthorities.size; attempt += 1) {
      await Promise.all([...this.liveAuthorities].map((authority) =>
        this.cleanupAuthority(authority, false, Date.now())
      ));
    }
    if (this.liveAuthorities.size) {
      throw new AggregateError(
        [...this.liveAuthorities].flatMap((authority) =>
          [...authority.processes].filter((handle) => handle.isAlive()),
        ),
        "Provider usage processes did not terminate",
      );
    }
  }

  pendingCount(): number {
    const providers = new Set(this.operations.keys());
    for (const authority of this.liveAuthorities) {
      if (authority.processes.size) providers.add(authority.provider);
    }
    return providers.size;
  }

  unavailableState(
    target: ProviderUsageTarget,
    code: ProviderUsageFailureCode = "unknown_failure",
  ): ProviderUsageStateDto {
    return {
      provider: target.adapter.id,
      displayName: target.displayName,
      authenticated: target.authenticated,
      refreshing: false,
      status: "unavailable",
      failure: failureDto(code),
    };
  }

  private entryFor(target: ProviderUsageTarget): ProviderUsageCacheEntry {
    return this.entryForAccount(target.adapter.id, target.accountKey);
  }

  private entryForAccount(provider: string, accountKey: string): ProviderUsageCacheEntry {
    const key = `${provider}\0${accountKey}`;
    const entry = this.entries.get(key) ?? {
      provider,
      accountKey,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private activeEntry(provider: string): ProviderUsageCacheEntry | undefined {
    const accountKey = this.activeAccounts.get(provider);
    return accountKey ? this.entries.get(`${provider}\0${accountKey}`) : undefined;
  }

  private isStale(provider: string): boolean {
    const startedAt = this.lastStartedAt.get(provider);
    if (!startedAt) return true;
    return Date.now() - startedAt >= this.staleMs;
  }

  private cleanupAuthority(
    authority: ProviderUsageAuthority,
    scheduleRetry: boolean,
    startedAt: number,
  ): Promise<void> {
    const existing = this.cleanupInFlight.get(authority);
    if (existing) return existing;
    const handles = [...authority.processes];
    const cleanup = Promise.allSettled(
      handles.map((handle) => handle.close()),
    ).then((results) => {
      let firstFailure: unknown;
      results.forEach((result, index) => {
        const handle = handles[index];
        if (!handle) return;
        if (result.status === "fulfilled" || !handle.isAlive()) {
          authority.processes.delete(handle);
        } else if (firstFailure === undefined) {
          firstFailure = result.reason;
        }
      });
      if (!authority.processes.size) {
        this.liveAuthorities.delete(authority);
        const timer = this.cleanupTimers.get(authority);
        if (timer) clearTimeout(timer);
        this.cleanupTimers.delete(authority);
        return;
      }
      if (!authority.cleanupReported) {
        authority.cleanupReported = true;
        const durationMs = Date.now() - startedAt;
        const failure = classifiedFailure(firstFailure, durationMs);
        this.reportFailure?.({
          event: "provider_usage_retrieval_failed",
          provider: authority.provider,
          failureCode: failure.code,
          durationMs,
          runtimeVersion: failure.runtimeVersion ?? "unknown",
          ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
          timedOut: failure.timedOut ?? false,
          cachedReturned: Boolean(this.activeEntry(authority.provider)?.reading),
          correlationId: failure.correlationId,
        });
      }
      if (scheduleRetry && !this.closed && !this.cleanupTimers.has(authority)) {
        const timer = setTimeout(() => {
          this.cleanupTimers.delete(authority);
          void this.cleanupAuthority(authority, true, startedAt);
        }, 1_000);
        timer.unref();
        this.cleanupTimers.set(authority, timer);
      }
    }).finally(() => {
      this.cleanupInFlight.delete(authority);
    });
    this.cleanupInFlight.set(authority, cleanup);
    return cleanup;
  }
}
