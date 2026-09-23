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
  const settledAttempts = entries
    .filter(isSettledMessageAttempt)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const finalAttempt = settledAttempts.at(-1);

  return entries.flatMap((entry) => {
    if (entry.kind === "run_header") return [];
    if (isSettledMessageAttempt(entry) && entry.result.isError !== true) return [];
    if (runStatus === "completed" &&
        finalAttempt?.result.isError === true &&
        entry.id === finalAttempt.id) {
      return [{
        id: entry.id,
        seq: entry.seq,
        createdAt: entry.createdAt,
        kind: "notice" as const,
        title: "Message delivery failed; task completed",
        detail: "Only the communication attempt failed. The Agent’s completed work remains available.",
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
