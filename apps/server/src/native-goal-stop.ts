import type { ActiveRun } from "./app-contracts.js";

/** The Run owns one pause attempt across cancellation and executor settlement.
 * An unknown acknowledgement is reported, never replayed, before process drain. */
export function pauseOwnedNativeGoal(
  run: ActiveRun,
  onUnknown: () => void,
): Promise<void> {
  if (run.nativeGoalPauseOperation) return run.nativeGoalPauseOperation;
  if (!run.nativeGoalActive || !run.runtimeSession?.pauseNativeGoal) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const operation = (async () => {
    try {
      await Promise.race([
        run.runtimeSession!.pauseNativeGoal!(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native goal pause confirmation timed out")), 3000);
        }),
      ]);
    } catch {
      onUnknown();
    } finally { if (timer) clearTimeout(timer); }
  })();
  run.nativeGoalPauseOperation = operation;
  return operation;
}
