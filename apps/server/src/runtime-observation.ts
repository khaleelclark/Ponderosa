import type { ProviderRootExitDetail, RuntimeProcessIdentity } from "@ponderosa/core";
import type { AgentLifecycleEvent } from "@ponderosa/agents";
import type { ActiveRun } from "./app-contracts.js";

/** Capture only host-owned/strictly projected observations. This does not infer
 * interruption cause from stderr, a signal, missing output, or provider prose. */
export function runtimeObservation(
  run: ActiveRun,
  process?: RuntimeProcessIdentity,
  rootExit?: ProviderRootExitDetail,
  hostOperation?: string,
): NonNullable<AgentLifecycleEvent["runtimeObservation"]> {
  const positive = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value > 0;
  const generation = run.observedProviderSessionGeneration;
  const exitCode = rootExit?.exitCode;
  const signal = rootExit?.signal;
  const operation = hostOperation?.slice(0, 160);
  return {
    runId: run.v3SchedulerRunId ?? run.runId,
    ...(positive(run.v3FencingToken) ? { fencingToken: run.v3FencingToken } : {}),
    runtimeGeneration: Number.isSafeInteger(run.generation) && run.generation >= 0 ? run.generation : 0,
    ...(generation ? { providerSessionGeneration: generation.slice(0, 256) } : {}),
    ...(process && positive(process.pid) ? { process: {
      pid: process.pid,
      ...(positive(process.pgid) ? { pgid: process.pgid } : {}),
      ...(process.birthMarker ? { birthMarker: process.birthMarker.slice(0, 128) } : {}),
    } } : {}),
    terminalEventObserved: run.observedProviderTerminalStatus !== undefined,
    ...(run.observedProviderTerminalStatus ? { terminalStatus: run.observedProviderTerminalStatus } : {}),
    ...(rootExit ? { rootExit: {
      ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= -2_147_483_648 && exitCode <= 2_147_483_647 ? { exitCode } : {}),
      ...(signal && /^SIG[A-Z0-9]{1,20}$/.test(signal) ? { signal } : {}),
    } } : {}),
    ...(operation ? { hostOperation: operation } : {}),
    origin: operation ? "host_operation_observed" : "not_established",
  };
}
