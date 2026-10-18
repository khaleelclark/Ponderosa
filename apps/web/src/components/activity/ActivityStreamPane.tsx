import type { ActivityStreamEntry } from "./activityStream";

export type GroupedActionEntry = Extract<
  ActivityStreamEntry,
  { kind: "command" | "tool" | "file" | "browser" | "notice" }
>;
export type ActivityDisplayEntry =
  | ActivityStreamEntry
  | { kind: "action_group"; id: string; entries: GroupedActionEntry[] };

export function groupConsecutiveActions(entries: ActivityStreamEntry[]): ActivityDisplayEntry[] {
  const grouped: ActivityDisplayEntry[] = [];
  let actions: GroupedActionEntry[] = [];
  const flush = () => {
    if (actions.length > 0) {
      grouped.push({
        kind: "action_group",
        id: `action-group:${actions[0]!.id}`,
        entries: actions,
      });
    }
    actions = [];
  };
  for (const entry of entries) {
    if (
      entry.kind === "command" ||
      entry.kind === "tool" ||
      entry.kind === "file" ||
      entry.kind === "browser" ||
      (entry.kind === "notice" && entry.result)
    ) {
      if (actions.length > 0 && actions[0]!.kind !== entry.kind) flush();
      actions.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
}
