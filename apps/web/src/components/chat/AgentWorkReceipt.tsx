import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
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
  if (!run) return "Unscoped work";
  if (run.status === "running" || run.status === "compacting") {
    return `${agentName} is working`;
  }
  if (
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
    run.status === "stalled" ||
    run.status === "blocked"
  ) {
    return `${agentName}'s work stopped`;
  }
  const duration = workDuration(run);
  return duration
    ? `${agentName} worked for ${duration}`
    : `${agentName} finished working`;
}

function receiptStatus(run: AgentRunDto): {
  label: string;
  color: "error" | "warning";
} | undefined {
  if (run.status === "failed") return { label: "Failed", color: "error" };
  if (run.status === "cancelled") return { label: "Cancelled", color: "warning" };
  if (run.status === "interrupted") return { label: "Interrupted", color: "warning" };
  if (run.status === "stalled" || run.status === "blocked") {
    return { label: "Needs attention", color: "warning" };
  }
  return undefined;
}

function isRenderedMessageDelivery(entry: ActivityStreamEntry): boolean {
  return entry.kind === "tool" &&
    entry.name === "ponderosa_message" &&
    entry.result?.isError !== true;
}

export function AgentWorkReceipt({
  agentName,
  run,
  active = false,
  entries,
  projectId,
  projectRoot,
  onOpenFile,
  onOpenFileInNewTab,
  focusId,
  inline = false,
}: {
  agentName: string;
  run?: AgentRunDto;
  active?: boolean;
  entries: ActivityStreamEntry[];
  projectId?: string;
  projectRoot?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  focusId?: string;
  inline?: boolean;
}): JSX.Element {
  const containsFocus =
    run?.id === focusId || entries.some(entry => entry.id === focusId);
  const [expanded, setExpanded] = useState(containsFocus || active);
  useEffect(() => {
    if (containsFocus || active) setExpanded(true);
  }, [active, containsFocus]);
  const visibleEntries = useMemo(
    () => entries.filter(
      entry => entry.kind !== "run_header" && !isRenderedMessageDelivery(entry),
    ),
    [entries],
  );
  const displayEntries = useMemo(
    () => groupConsecutiveActions(visibleEntries),
    [visibleEntries],
  );
  const activityCount = visibleEntries.filter(
    entry => entry.kind !== "thinking" && entry.kind !== "response",
  ).length;
  const status = run ? receiptStatus(run) : undefined;
  const activitySummary = activityCount === 1
    ? "1 activity"
    : `${activityCount} activities`;

  return (
    <Box
      id={run ? telemetryElementId("runs", run.id) : "unscoped-work"}
      component={inline ? "section" : "article"}
      aria-label={run ? `${agentName} work details` : "Unscoped work details"}
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
              {receiptTitle(agentName, run)}
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
          {status ? (
            <Chip
              size="small"
              color={status.color}
              label={status.label}
              sx={{ height: 20, fontSize: 10.5 }}
            />
          ) : null}
        </Stack>
        {expanded ? (
          <Box
            sx={{
              mt: 0.25,
              mb: 0.5,
            }}
          >
            {displayEntries.length ? (
              displayEntries.map(entry => {
                if (entry.kind === "action_group") {
                  return (
                    <ActionGroupRow
                      key={entry.id}
                      entries={entry.entries}
                      focusId={focusId}
                      projectRoot={projectRoot}
                      onOpenFile={onOpenFile}
                      onOpenFileInNewTab={onOpenFileInNewTab}
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
                      onOpenFileInNewTab={onOpenFileInNewTab}
                      projectId={projectId}
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
              })
            ) : (
              <Typography
                color="text.secondary"
                sx={{ px: 0.75, py: 1, fontSize: 12 }}
              >
                No detailed activity was recorded for this Run.
              </Typography>
            )}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
