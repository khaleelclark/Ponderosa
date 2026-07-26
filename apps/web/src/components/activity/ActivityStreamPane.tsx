import { Chip, Stack, Typography } from "@mui/material";
import type {
  AgentActivityDto,
  AgentRunDto,
  ResponseFileActivityDto,
  RunOutputDto,
} from "@ponderosa/core";
import { useMemo } from "react";
import { chatStateKey } from "../../chatState";
import { ChatSurface } from "../chat/ChatSurface";
import {
  ActionGroupRow,
  CommandRow,
  CompactActivityRow,
  FileRow,
  ResponseRow,
  RunHeaderRow,
  ThinkingRow,
  ToolRow,
} from "./ActivityRows";
import { buildActivityStream } from "./activityStream";
import type { ActivityStreamEntry } from "./activityStream";

type GroupedActionEntry = Extract<ActivityStreamEntry, { kind: "command" | "tool" | "browser" }>;
type ActivityDisplayEntry =
  | ActivityStreamEntry
  | { kind: "action_group"; id: string; entries: GroupedActionEntry[] };

const MAX_ACTION_GROUP_GAP_MS = 10_000;
const MAX_ACTION_GROUP_IDLE_SPAN_MS = 30_000;

function groupConsecutiveActions(entries: ActivityStreamEntry[]): ActivityDisplayEntry[] {
  const grouped: ActivityDisplayEntry[] = [];
  let actions: GroupedActionEntry[] = [];
  let accumulatedIdleMs = 0;
  const flush = () => {
    const commandCount = actions.filter((entry) => entry.kind === "command").length;
    const toolCount = actions.filter((entry) => entry.kind === "tool").length;
    const shouldGroup = commandCount >= 3 || toolCount >= 2 || (commandCount >= 1 && toolCount >= 1);
    if (shouldGroup) {
      grouped.push({
        kind: "action_group",
        id: `action-group:${actions[0]!.id}`,
        entries: actions,
      });
    } else {
      grouped.push(...actions);
    }
    actions = [];
    accumulatedIdleMs = 0;
  };
  const append = (entry: GroupedActionEntry) => {
    const previous = actions.at(-1);
    if (previous) {
      const previousCompletedAt = previous.kind === "browser"
        ? previous.createdAt
        : previous.result?.completedAt ?? previous.createdAt;
      const previousCompletedTime = Date.parse(previousCompletedAt ?? "");
      const entryStartTime = Date.parse(entry.createdAt);
      const invalidTime = !Number.isFinite(previousCompletedTime) ||
        !Number.isFinite(entryStartTime);
      const idleGap = Math.max(0, entryStartTime - previousCompletedTime);
      if (invalidTime ||
          idleGap >= MAX_ACTION_GROUP_GAP_MS ||
          accumulatedIdleMs + idleGap > MAX_ACTION_GROUP_IDLE_SPAN_MS) {
        flush();
      } else {
        accumulatedIdleMs += idleGap;
      }
    }
    actions.push(entry);
  };
  for (const entry of entries) {
    if (entry.kind === "command" && !entry.internal) {
      append(entry);
      continue;
    }
    if (entry.kind === "tool") {
      append(entry);
      continue;
    }
    if (entry.kind === "browser") {
      append(entry);
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
  onOpenFileInNewTab,
  onViewAll,
}: {
  agentId: string;
  activity: AgentActivityDto[];
  runOutput?: RunOutputDto[];
  runs?: AgentRunDto[];
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
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
}): JSX.Element {
  const entries = useMemo(() => buildActivityStream({
    activity,
    runOutput,
    runs,
    ...(activeExecutionId ? { activeExecutionId } : {}),
  }), [activity, runOutput, runs, activeExecutionId]);
  const displayEntries = useMemo(() => groupConsecutiveActions(entries), [entries]);
  const last = entries.at(-1);
  const latestActivitySeq = activity.reduce(
    (latest, item) => Math.max(latest, item.seq),
    0,
  );
  const latestRunOutputSeq = runOutput.reduce(
    (latest, item) => Math.max(latest, item.sourceSeqEnd),
    0,
  );
  const layoutKey = last
    ? `${entries.length}:${last.id}:${latestActivitySeq}:${latestRunOutputSeq}`
    : `0:${latestActivitySeq}:${latestRunOutputSeq}`;
  return <ChatSurface
    layout="workspace"
    label="Agent activity"
    layoutKey={layoutKey}
    follow={{ kind: "latest", storageKey: chatStateKey("scroll", `agent.${agentId}.activity`) }}
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
    scrollTestId="activity-scroll-region"
  >
    {displayEntries.map((entry) => {
      if (entry.kind === "action_group") return <ActionGroupRow
        key={entry.id}
        entries={entry.entries}
        focusId={focusId}
        projectRoot={projectRoot}
      />;
      if (entry.kind === "run_header") return <RunHeaderRow key={entry.id} entry={entry} />;
      if (entry.kind === "thinking") return <ThinkingRow key={entry.id} entry={entry} focusId={focusId} />;
      if (entry.kind === "response") return <ResponseRow
        key={entry.id}
        entry={entry}
        focusId={focusId}
        onOpenFile={onOpenFile}
        onOpenFileInNewTab={onOpenFileInNewTab}
        onViewAll={onViewAll}
        projectId={projectId}
      />;
      if (entry.kind === "command") return <CommandRow key={entry.id} entry={entry} focusId={focusId} projectRoot={projectRoot} />;
      if (entry.kind === "tool") return <ToolRow key={entry.id} entry={entry} focusId={focusId} />;
      if (entry.kind === "file") return <FileRow
        key={entry.id}
        entry={entry}
        focusId={focusId}
        onOpenFile={onOpenFile}
        onOpenFileInNewTab={onOpenFileInNewTab}
      />;
      if (entry.kind === "test" || entry.kind === "error" || entry.kind === "browser" || entry.kind === "notice") {
        return <CompactActivityRow key={entry.id} entry={entry} focusId={focusId} />;
      }
      return null;
    })}
  </ChatSurface>;
}
