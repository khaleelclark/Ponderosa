import { PONDEROSA_MESSAGE_TOOL } from "@ponderosa/core";
import type { AgentRunDto } from "@ponderosa/core";
import type { ActivityStreamEntry } from "../activity/activityStream.js";

function isSettledMessageAttempt(
  entry: ActivityStreamEntry,
): entry is Extract<ActivityStreamEntry, { kind: "tool" }> & {
  result: NonNullable<Extract<ActivityStreamEntry, { kind: "tool" }>["result"]>;
} {
  return entry.kind === "tool" &&
    entry.name === PONDEROSA_MESSAGE_TOOL.name &&
    entry.result !== undefined;
}

export function receiptActivityEntries(
  entries: ActivityStreamEntry[],
  runStatus: AgentRunDto["status"] | undefined,
): ActivityStreamEntry[] {
  const failedAttempts = entries
    .filter(isSettledMessageAttempt)
    .filter((entry) => entry.result.isError === true)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const latestFailure = failedAttempts.at(-1);

  // ponytail: activity cannot prove same-operation/destination recovery. Keep
  // the notice until a host-owned structured recovery contract can do so.

  return entries.flatMap((entry) => {
    if (entry.kind === "run_header") return [];
    if (isSettledMessageAttempt(entry) && entry.result.isError !== true) return [];
    if (runStatus === "completed" &&
        entry === latestFailure) {
      return [entry, {
        id: `${entry.id}:communication-recovery-unconfirmed`,
        seq: entry.seq,
        createdAt: entry.createdAt,
        kind: "notice" as const,
        title: "Communication recovery unconfirmed; task completed",
        detail: "A communication attempt failed; recovery is unconfirmed. The Agent’s completed work remains available.",
      }];
    }
    return [entry];
  });
}

export function hasVisibleReceiptActivity(
  entries: ActivityStreamEntry[],
  runStatus: AgentRunDto["status"] | undefined,
): boolean {
  return receiptActivityEntries(entries, runStatus).length > 0;
}
