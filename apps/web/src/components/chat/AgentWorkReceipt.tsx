import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, Button, Stack, Typography } from "@mui/material";
import type {
  AgentRunDto,
  ResponseFileActivityDto,
} from "@ponderosa/core";
import { useEffect, useMemo, useState } from "react";
import { telemetryElementId } from "../../telemetryFocus";
import { formatFinalizedWorkDuration } from "../../time";
import {
  groupConsecutiveActions,
} from "../activity/ActivityStreamPane";
import {
  ActionGroupRow,
  CompactActivityRow,
  ResponseRow,
  ThinkingRow,
} from "../activity/ActivityRows";
import type { ActivityStreamEntry } from "../activity/activityStream";
import { SemanticStatus, semanticAgentStatus } from "../SemanticStatus";
import { receiptActivityEntries } from "./receiptActivityEntries";

function workDuration(run: AgentRunDto): string | undefined {
  if (!run.completedAt) return undefined;
  const duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0
    ? formatFinalizedWorkDuration(duration)
    : undefined;
}

function receiptTitle(
  agentName: string,
  run: AgentRunDto | undefined,
): string {
  if (!run) return "Unscoped Work";
  if (run.status === "running" || run.status === "compacting") {
    return `${agentName} Is Working`;
  }
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
    run.status === "stalled" ||
    run.status === "blocked"
  ) {
    return `${agentName}'s Work Stopped`;
  }
  const duration = workDuration(run);
  return duration
    ? `${agentName} Worked For ${duration}`
    : `${agentName} Finished Working`;
}

function receiptStatus(run: AgentRunDto, paused: boolean): {
  label: string;
  status: ReturnType<typeof semanticAgentStatus>;
  detail?: string;
  accessibleLabel?: string;
} | undefined {
  if (run.status === "failed") return { label: "Failed", status: "failed" };
  if (paused && run.status === "cancelled") {
    return {
      label: "Paused",
      status: "waiting",
      detail: "Run status: cancelled",
      accessibleLabel: "Paused. Run status: cancelled",
    };
  }
  if (run.status === "cancelled") return { label: "Cancelled", status: "failed" };
  if (run.status === "interrupted") return { label: "Interrupted", status: "blocked" };
  if (run.status === "stalled" || run.status === "blocked") {
    return { label: "Needs Attention", status: semanticAgentStatus(run.status) };
  }
  return undefined;
}

export function AgentWorkReceipt({
  agentName,
  run,
  active = false,
  paused = false,
  entries,
  projectId,
  projectRoot,
  onOpenFile,
  focusId,
  inline = false,
  assistantMessages = false,
}: {
  agentName: string;
  run?: AgentRunDto;
  active?: boolean;
  paused?: boolean;
  entries: ActivityStreamEntry[];
  projectId?: string;
  projectRoot?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  focusId?: string;
  inline?: boolean;
  assistantMessages?: boolean;
}): JSX.Element | null {
  const containsFocus =
    run?.id === focusId || entries.some(entry => entry.id === focusId);
  const [expanded, setExpanded] = useState(containsFocus || (!assistantMessages && active));
  useEffect(() => {
    if (containsFocus || (!assistantMessages && active)) setExpanded(true);
  }, [active, containsFocus, assistantMessages]);
  const visibleEntries = useMemo(
    () => receiptActivityEntries(entries, run?.status, assistantMessages),
    [entries, run?.status, assistantMessages],
  );
  const displayEntries = useMemo(
    () => groupConsecutiveActions(visibleEntries),
    [visibleEntries],
  );
  const hasVisibleActivity = displayEntries.length > 0;
  const activityCount = visibleEntries.length;
  const status = run ? receiptStatus(run, paused) : undefined;
  const activitySummary = activityCount === 1
    ? "1 activity"
    : `${activityCount} activities`;

  if(assistantMessages && !hasVisibleActivity) return null;
  return (
    <Box
      id={run ? telemetryElementId("runs", run.id) : "unscoped-work"}
      component="article"
      aria-label={run ? `${agentName} Work Details` : "Unscoped Work Details"}
      tabIndex={run?.id === focusId ? -1 : undefined}
      sx={{
        width: inline ? "100%" : "min(1120px, 100%)",
        maxWidth: "100%",
        pl: inline ? 0 : { xs: 5, sm: 6.5 },
        pt: inline ? 0 : 0.25,
        pb: inline ? 0 : 0.25,
      }}
    >
      <Box
        sx={{
          maxWidth: inline ? "none" : 960,
          pt: 0,
        }}
      >
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
          {hasVisibleActivity ? (
            <Button
              color="inherit"
              startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              onClick={() => setExpanded(current => !current)}
              aria-expanded={expanded}
              sx={{
                minWidth: 0,
                minHeight: 30,
                px: 0.5,
                justifyContent: "flex-start",
                color: "text.secondary",
                textTransform: "none",
              }}
            >
              <Box
                component="span"
                sx={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12.5,
                  fontWeight: 700,
                }}
              >
                {paused ? `${agentName}'s work is paused` : receiptTitle(agentName, run)}
              </Box>
              <Box
                component="span"
                sx={{
                  ml: 0.75,
                  flexShrink: 0,
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: "text.secondary",
                }}
              >
                · {activitySummary}
              </Box>
            </Button>
          ) : (
            <Stack
              component="span"
              direction="row"
              spacing={0.75}
              sx={{
                minWidth: 0,
                minHeight: 30,
                px: 0.5,
                alignItems: "center",
                color: "text.secondary",
              }}
            >
              <Box
                component="span"
                sx={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12.5,
                  fontWeight: 700,
                }}
              >
                {paused ? `${agentName}'s work is paused` : receiptTitle(agentName, run)}
              </Box>
              <Box
                component="span"
                sx={{
                  flexShrink: 0,
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: "text.secondary",
                }}
              >
                · {activitySummary}
              </Box>
            </Stack>
          )}
          {status ? (
            <SemanticStatus
              status={status.status}
              label={status.label}
              detail={status.detail}
              accessibleLabel={status.accessibleLabel}
            />
          ) : null}
        </Stack>
        {paused ? <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 0.5 }}>
          Work is paused.
        </Typography> : null}
        {expanded && hasVisibleActivity ? (
          <Box
            sx={{
              mt: 0.25,
              mb: 0.5,
            }}
          >
            {displayEntries.map(entry => {
              if (entry.kind === "action_group") {
                return (
                  <ActionGroupRow
                    key={entry.id}
                    entries={entry.entries}
                    focusId={focusId}
                    projectRoot={projectRoot}
                    onOpenFile={onOpenFile}
                  />
                );
              }
              if (entry.kind === "thinking") {
                return (
                  <ThinkingRow
                    key={entry.id}
                    entry={entry}
                    focusId={focusId}
                  />
                );
              }
              if (entry.kind === "response") {
                return (
                  <ResponseRow
                    key={entry.id}
                    entry={entry}
                    focusId={focusId}
                    onOpenFile={onOpenFile}
                    projectId={projectId}
                    projectRoot={projectRoot}
                  />
                );
              }
              if (
                entry.kind === "test" ||
                entry.kind === "error" ||
                entry.kind === "browser" ||
                entry.kind === "notice"
              ) {
                return (
                  <CompactActivityRow
                    key={entry.id}
                    entry={entry}
                    focusId={focusId}
                  />
                );
              }
              return null;
            })}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
