import { Chip, Stack, Typography } from "@mui/material";
import type {
  AgentActivityDto,
  AgentRunDto,
  MessageDto,
  ResponseFileActivityDto,
  RunOutputDto,
} from "@ponderosa/core";
import { useMemo } from "react";
import { chatStateKey } from "../../chatState";
import { ChatSurface } from "../chat/ChatSurface";
import {
  ActionGroupRow,
  CompactActivityRow,
  ResponseRow,
  RunHeaderRow,
  ThinkingRow,
} from "./ActivityRows";
import { buildActivityStream } from "./activityStream";
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

export function ActivityStreamPane({
  agentId,
  activity,
  runOutput = [],
  runs = [],
  messages = [],
  connected,
  running,
  activeExecutionId,
  focusId,
  projectId,
  projectRoot,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  onOpenFile,
  onViewAll,
}: {
  agentId: string;
  activity: AgentActivityDto[];
  runOutput?: RunOutputDto[];
  runs?: AgentRunDto[];
  messages?: MessageDto[];
  connected: boolean;
  running: boolean;
  activeExecutionId?: string;
  focusId?: string;
  projectId?: string;
  projectRoot?: string;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier(): void;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
}): JSX.Element {
  const entries = useMemo(() => buildActivityStream({
    activity,
    runOutput,
    runs,
    messages,
    ...(activeExecutionId ? { activeExecutionId } : {}),
  }), [activity, runOutput, runs, messages, activeExecutionId]);
  const displayEntries = useMemo(() => groupConsecutiveActions(entries), [entries]);
  const latestRunOutputSeq = runOutput.reduce(
    (latest, item) => Math.max(latest, item.sourceSeqEnd),
    0,
  );
  const lastDisplayEntry = displayEntries.at(-1);
  const layoutKey = lastDisplayEntry
    ? `${displayEntries.length}:${lastDisplayEntry.id}:${latestRunOutputSeq}`
    : `0:${latestRunOutputSeq}`;
  return <ChatSurface
    layout="workspace"
    label="Agent activity"
    layoutKey={layoutKey}
    follow={{
      kind: "latest",
      bottomThreshold: 4,
      followResizes: false,
      storageKey: chatStateKey("scroll", `agent.${agentId}.activity`),
    }}
    history={{
      kind: "cursor",
      hasEarlier,
      loading: loadingEarlier,
      onLoadEarlier,
      label: "Load Earlier Activity",
    }}
    beforeMessages={<Stack direction="row" spacing={1} sx={{ alignItems: "center", pb: 1 }}>
      <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Activity</Typography>
      <Chip size="small" label={connected ? "Live" : "Reconnecting"} color={connected ? "success" : "warning"} variant={connected ? "filled" : "outlined"} />
      {running ? <Chip size="small" color="info" label="Working" /> : null}
    </Stack>}
    empty="Thinking, responses, commands, tool calls, file changes, and browser actions will appear here."
  >
    {displayEntries.map((entry) => {
      if (entry.kind === "action_group") return <ActionGroupRow
        key={entry.id}
        entries={entry.entries}
        focusId={focusId}
        projectRoot={projectRoot}
        onOpenFile={onOpenFile}
      />;
      if (entry.kind === "run_header") return <RunHeaderRow key={entry.id} entry={entry} />;
      if (entry.kind === "thinking") return <ThinkingRow key={entry.id} entry={entry} focusId={focusId} />;
      if (entry.kind === "response") return <ResponseRow
        key={entry.id}
        entry={entry}
        focusId={focusId}
        onOpenFile={onOpenFile}
        onViewAll={onViewAll}
        projectId={projectId}
        projectRoot={projectRoot}
      />;
      if (entry.kind === "test" || entry.kind === "error" || entry.kind === "browser" || entry.kind === "notice") {
        return <CompactActivityRow key={entry.id} entry={entry} focusId={focusId} />;
      }
      return null;
    })}
  </ChatSurface>;
}
