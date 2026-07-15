import type { CoordinationV3Store, SchedulerLease } from "@ponderosa/agents";

export interface CoordinationV3DispatchResult {
  accepted: boolean;
  retryable?: boolean;
  error?: string;
}

export interface CoordinationV3SchedulerMetrics {
  claimedRuns: number;
  acceptedRuns: number;
  rejectedRuns: number;
  outboxSignals: number;
  dispatchLatencyMs: number[];
}

export class CoordinationV3Scheduler {
  private timer?: NodeJS.Timeout;
  private draining = false;
  private stopped = false;
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
    },
  ) {}

  start(): void {
    if (this.stopped) throw new Error("scheduler has been stopped");
    this.schedule(0);
  }

  notify(): void {
    if (!this.stopped) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) (this.options.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
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
      for (const item of this.store.claimOutbox(this.options.workerId, 500, now)) {
        this.store.completeOutbox(item.id, this.options.workerId, now);
        this.metrics.outboxSignals += 1;
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
        let result: CoordinationV3DispatchResult;
        try {
          result = await this.dispatch(lease, formatActivationPrompt(lease));
        } catch (error) {
          result = { accepted: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
        }
        this.metrics.dispatchLatencyMs.push(Math.max(0, (this.options.now ?? Date.now)() - started));
        if (result.accepted) {
          this.metrics.acceptedRuns += 1;
        } else {
          this.metrics.rejectedRuns += 1;
          this.store.failRun({
            runId: lease.runId,
            fencingToken: lease.fencingToken,
            workerId: this.options.workerId,
            sameRunResumable: false,
            retryDelayMs: result.retryable === false ? 30_000 : 500,
            now: new Date((this.options.now ?? Date.now)()).toISOString(),
          });
        }
      }
    } finally {
      this.draining = false;
    }
    return dispatched;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.stopped) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      this.timer = undefined;
      void this.drainOnce().finally(() => this.schedule(this.options.pollMs ?? 250));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function formatActivationPrompt(lease: SchedulerLease): string {
  return [
    "Ponderosa Communication V3 activation batch.",
    `Run: ${lease.runId}`,
    "Handle every source exactly once. A human or urgent activation does not cancel your open joins.",
    "When a correlated request changes state, call ponderosa_update_request with its stable requestId and a new stable updateId.",
    ...lease.activations.map((activation, index) => [
      `Activation ${index + 1}:`,
      `- activationId: ${activation.id}`,
      `- kind: ${activation.kind}`,
      `- priority: ${activation.priority}`,
      `- payload: ${JSON.stringify(activation.payload)}`,
    ].join("\n")),
  ].join("\n");
}
