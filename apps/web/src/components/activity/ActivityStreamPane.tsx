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
  CommandGroupRow,
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

type CommandEntry = Extract<ActivityStreamEntry, { kind: "command" }>;
type ActivityDisplayEntry =
  | ActivityStreamEntry
  | { kind: "command_group"; id: string; entries: CommandEntry[] };

function groupConsecutiveCommands(entries: ActivityStreamEntry[]): ActivityDisplayEntry[] {
  const grouped: ActivityDisplayEntry[] = [];
  let commands: CommandEntry[] = [];
  const flush = () => {
    if (commands.length >= 3) {
      grouped.push({
        kind: "command_group",
        id: `command-group:${commands[0]!.id}`,
        entries: commands,
      });
    } else {
      grouped.push(...commands);
    }
    commands = [];
  };
  for (const entry of entries) {
    if (entry.kind === "command" && !entry.internal && entry.result) {
      commands.push(entry);
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
  const displayEntries = useMemo(() => groupConsecutiveCommands(entries), [entries]);
  const last = entries.at(-1);
  const layoutKey = last ? `${entries.length}:${last.id}:${last.seq}` : "0";
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
      if (entry.kind === "command_group") return <CommandGroupRow
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
