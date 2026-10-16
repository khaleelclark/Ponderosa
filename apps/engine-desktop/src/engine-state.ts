export type ObservableEngineState = "running" | "reachable" | "degraded";

export interface EngineReadinessSnapshot {
  status: "ready" | "not_ready";
  canAcceptWork: boolean;
  acceptingDurableIntake: boolean;
  leasingRuns: boolean;
  checks: Record<string, { ok: boolean; detail: string }>;
}

export function classifyEngineReadiness(
  readiness: EngineReadinessSnapshot | undefined,
): { state: ObservableEngineState; detail: string } {
  if (!readiness) {
    return {
      state: "reachable",
      detail: "The local service is reachable; intake readiness could not be verified yet.",
    };
  }
  if (readiness.canAcceptWork) {
    return { state: "running", detail: "The local service is ready to accept work." };
  }
  const failedCheck = Object.values(readiness.checks).find((check) => !check.ok);
  return {
    state: "degraded",
    detail: failedCheck?.detail ?? (readiness.acceptingDurableIntake && !readiness.leasingRuns
      ? "The local service is reachable, but provider leasing is paused."
      : "The local service is reachable, but it is not ready to accept work."),
  };
}

export interface LogTail {
  stream: "server" | "error";
  text: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
}

export type EngineState = "starting" | "running" | "reachable" | "degraded" | "stopping" | "cleanup_incomplete" | "stopped" | "error";

export interface EngineSnapshot {
  state: EngineState;
  detail: string;
  pid?: number;
  version?: string;
  revision?: string;
  channel?: string;
  startedAt?: string;
  dataDir?: string;
  acceptingDurableIntake?: boolean;
  leasingRuns?: boolean;
  activeRunCount: number;
  logs: {
    server: LogTail;
    error: LogTail;
  };
}
