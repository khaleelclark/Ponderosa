import type { CoordinationV3Store, ProviderOperation, SchedulerLease, SteeringLease } from "@ponderosa/agents";

export interface CoordinationV3DispatchResult {
  accepted: boolean;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  error?: string;
}

export interface CoordinationV3SchedulerMetrics {
  claimedRuns: number;
  acceptedRuns: number;
  rejectedRuns: number;
  outboxSignals: number;
  dispatchLatencyMs: number[];
  lastDispatchError?: string;
}

export class CoordinationV3Scheduler {
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;
  private maintenanceDrains = 0;
  private readonly stopWaiters = new Set<() => void>();
  private readonly metrics: CoordinationV3SchedulerMetrics = {
    claimedRuns: 0,
    acceptedRuns: 0,
    rejectedRuns: 0,
    outboxSignals: 0,
    dispatchLatencyMs: [],
  };

  constructor(
    private readonly store: CoordinationV3Store,
    private readonly dispatch: (lease: SchedulerLease, prompt: string) => Promise<CoordinationV3DispatchResult>,
    private readonly options: {
      workerId: string;
      maxConcurrentRuns?: number;
      pollMs?: number;
      leaseMs?: number;
      coalesceLimit?: number;
      now?: () => number;
      setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
      clearTimer?: (timer: NodeJS.Timeout) => void;
      dispatchSteering?: (lease: SteeringLease, prompt: string) => Promise<CoordinationV3DispatchResult>;
      dispatchProviderOperation?: (operation: ProviderOperation) => Promise<CoordinationV3DispatchResult>;
    },
  ) {}

  start(): void {
    if (this.stopped) throw new Error("scheduler has been stopped");
    this.store.pruneSettledOutboxes();
    this.schedule(0);
  }

  notify(): void {
    if (!this.stopped) this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
    if (this.draining) {
      await new Promise<void>((resolve) => this.stopWaiters.add(resolve));
    }
  }

  snapshotMetrics(): CoordinationV3SchedulerMetrics {
    return { ...this.metrics, dispatchLatencyMs: [...this.metrics.dispatchLatencyMs] };
  }

  async drainOnce(): Promise<number> {
    if (this.draining || this.stopped) return 0;
    this.draining = true;
    let dispatched = 0;
    try {
      const now = new Date((this.options.now ?? Date.now)()).toISOString();
      this.store.expireDue(now);
      this.store.processDueTriggerOccurrences(now);
      for (const item of this.store.claimOutbox(this.options.workerId, 500, now)) {
        this.store.completeOutbox(item.id, this.options.workerId, now);
        this.metrics.outboxSignals += 1;
      }
      if (this.options.dispatchProviderOperation) {
        for (const operation of this.store.claimProviderOperations(this.options.workerId, 50, now)) {
          let result: CoordinationV3DispatchResult;
          try {
            result = await this.options.dispatchProviderOperation(operation);
          } catch (error) {
            result = { accepted: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
          }
          if (result.accepted) this.store.completeProviderOperation(operation.id, this.options.workerId);
          else if (result.retryable === false) this.store.deadLetterProviderOperation(
            operation.id, this.options.workerId, result.error ?? "provider operation rejected",
          );
          else this.store.failProviderOperation(
            operation.id, this.options.workerId, result.error ?? "provider operation rejected", 500,
          );
        }
      }
      if (this.options.dispatchSteering) {
        while (true) {
          const steering = this.store.leaseNextSteering({ workerId: this.options.workerId, now });
          if (!steering) break;
          const prompt = formatActivationPrompt(steering);
          try {
            this.store.preparePromptInjection({
              injectionId: steering.injectionId,
              runId: steering.runId,
              fencingToken: steering.fencingToken,
              prompt,
            });
          } catch (error) {
            // Cancellation/deletion may advance the fence after leasing. That
            // race is already durably settled and must not reject the drain.
            this.metrics.lastDispatchError = error instanceof Error ? error.message : String(error);
            continue;
          }
          let result: CoordinationV3DispatchResult;
          try {
            result = await this.options.dispatchSteering(steering, prompt);
          } catch (error) {
            result = { accepted: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
          }
          if (!result.accepted) {
            try {
              if (result.outcomeUnknown) this.store.markSteeringOutcomeUnknown({
                injectionId: steering.injectionId,
                runId: steering.runId,
                fencingToken: steering.fencingToken,
              });
              else this.store.deferSteering({
                injectionId: steering.injectionId,
                runId: steering.runId,
                fencingToken: steering.fencingToken,
                retryDelayMs: result.retryable === false ? 30_000 : 500,
              });
            } catch (error) {
              this.metrics.lastDispatchError = error instanceof Error ? error.message : String(error);
            }
          }
        }
      }
      const maximum = this.options.maxConcurrentRuns ?? 8;
      while (this.store.activeRunCount() < maximum) {
        const lease = this.store.leaseNextRun({
          workerId: this.options.workerId,
          leaseMs: this.options.leaseMs,
          coalesceLimit: this.options.coalesceLimit,
          now: new Date((this.options.now ?? Date.now)()).toISOString(),
        });
        if (!lease) break;
        dispatched += 1;
        this.metrics.claimedRuns += 1;
        const started = (this.options.now ?? Date.now)();
        const prompt = formatActivationPrompt(lease);
        try {
          this.store.preparePromptInjection({
            injectionId: lease.injectionId,
            runId: lease.runId,
            fencingToken: lease.fencingToken,
            prompt,
          });
        } catch (error) {
          this.metrics.lastDispatchError = error instanceof Error ? error.message : String(error);
          continue;
        }
        let result: CoordinationV3DispatchResult;
        try {
          result = await this.dispatch(lease, prompt);
        } catch (error) {
          result = { accepted: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
        }
        this.metrics.dispatchLatencyMs.push(Math.max(0, (this.options.now ?? Date.now)() - started));
        if (result.accepted) {
          this.metrics.acceptedRuns += 1;
        } else {
          this.metrics.rejectedRuns += 1;
          this.metrics.lastDispatchError = result.error ?? "scheduler dispatch rejected";
          try {
            this.store.failRun({
              runId: lease.runId,
              fencingToken: lease.fencingToken,
              workerId: this.options.workerId,
              sameRunResumable: false,
              retryDelayMs: result.retryable === false ? 30_000 : 500,
              now: new Date((this.options.now ?? Date.now)()).toISOString(),
            });
          } catch (error) {
            this.metrics.lastDispatchError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      this.maintenanceDrains += 1;
      if (this.maintenanceDrains % 256 === 0) this.store.pruneSettledOutboxes();
    } finally {
      this.draining = false;
      for (const resolve of this.stopWaiters) resolve();
      this.stopWaiters.clear();
    }
    return dispatched;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.stopped) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      this.timer = undefined;
      void this.drainOnce()
        .catch((error) => {
          this.metrics.lastDispatchError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => this.schedule(this.options.pollMs ?? 250));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function formatActivationPrompt(
  lease: SchedulerLease | SteeringLease,
  limits: { maxChars?: number; maxInlineChars?: number } = {},
): string {
  const maxChars = Math.max(4_000, limits.maxChars ?? 24_000);
  const maxInlineChars = Math.max(500, limits.maxInlineChars ?? 6_000);
  const classOrder = { human: 0, blocker: 1, coordination: 2, ordinary: 3 } as const;
  const ordered = [...lease.activations].sort((a, b) =>
    classOrder[a.promptClass] - classOrder[b.promptClass] || b.priority - a.priority,
  );
  let remaining = maxChars;
  const materialized = ordered.map((activation, index) => {
    const serialized = JSON.stringify(activation.payload);
    const available = Math.max(0, Math.min(maxInlineChars, remaining));
    const inline = serialized.length <= available ? serialized : serialized.slice(0, available);
    remaining -= inline.length;
    const overflow = inline.length < serialized.length;
    return [
      `Activation ${index + 1}:`,
      `- activationId: ${activation.id}`,
      `- kind: ${activation.kind}`,
      `- priority: ${activation.priority}`,
      `- promptClass: ${activation.promptClass}`,
      `- payload: ${inline}${overflow ? "…" : ""}`,
      ...(overflow ? [
        `- overflow: explicit (${serialized.length - inline.length} characters omitted from this prompt only)`,
        `- fullResultRef: ponderosa://activation/${activation.id}`,
      ] : []),
    ].join("\n");
  });
  return [
    "Ponderosa Communication V3 activation batch.",
    `Run: ${lease.runId}`,
    "Handle every source exactly once. A human or urgent activation does not cancel your open joins.",
    "Ordinary runtime output is only a Work log. For a human activation, explicitly use ponderosa_message with direct_to_user, or broadcast only when its payload sets shareWithOrganization true.",
    "For an inbound request, you are its recipient. Report with ponderosa_update_request. When exactly one correlated request is attached to this run, omit requestId so Ponderosa selects it from authoritative run state; use the exact requestId only when multiple requests are attached. If the request itself asks for information or consultation, send that reply as completed. Use question only when you need a blocking follow-up from the original requester; answer is reserved for that requester replying to your question update.",
    "A join activation may include continuations: inbound parent requests suspended while you waited for child work. After integrating the joined outcomes, terminally update every nonterminal continuation with ponderosa_update_request before ending. ponderosa_message does not complete a correlated request.",
    "Recipients do not inherit a requester's hidden prompt or provider-session context. Work only from the durable request payload and referenced artifacts; ask one blocking question when required information is genuinely absent.",
    "Keep bounded work bounded: inspect only what the request needs, avoid repeated verification, run final checks once, send exactly one terminal request update only after all work and edits are complete, then stop working on that request.",
    "For an outbound request, do not repeat or forward the recipient's update; consume its outcome directly. Only the requester or user may answer, cancel, or supersede it.",
    "Full payloads remain durable. Use ponderosa_coordinate inspection when a fullResultRef is present.",
    ...materialized,
  ].join("\n");
}
