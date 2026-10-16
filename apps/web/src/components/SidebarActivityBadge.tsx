import { Box, Tooltip } from "@mui/material";
import { AGENT_DISPLAY_STATUS_LABELS, type WorkspaceActivityCountDto } from "@ponderosa/core";
import { semanticStatusColorToken } from "./SemanticStatus";

export function SidebarActivityBadge({ activity, fresh = false, showLabel = false }: { activity?: WorkspaceActivityCountDto; fresh?: boolean; showLabel?: boolean }) {
  const status = activity?.status ?? "unknown";
  const label = status === "unknown" ? "Unknown" : AGENT_DISPLAY_STATUS_LABELS[status];
  const detail = activity
    ? `${label}; ${activity.runningCount} working, ${activity.waitingCount} waiting, ${activity.decisionCount} need decision, ${activity.recoveryCount} recovering, ${activity.errorCount} errors, ${activity.idleCount} idle, ${activity.unknownCount} unknown. Last confirmed ${activity.lastConfirmedAt ?? "unavailable"}${fresh ? "" : "; updates may be delayed"}.`
    : "Agent status unknown; no confirmed status available.";
  const count = activity?.activeCount ?? 0;

  return <Tooltip title={detail}>
    <Box component="span" role="img" data-sidebar-column="activity" data-agent-status={status} aria-label={detail} tabIndex={0}
      sx={{ display: "inline-flex", alignItems: "center", gap: .5, flexShrink: 0, color: theme => semanticStatusColorToken(status === "unknown" ? "idle" : status, theme.palette.mode), fontSize: 11, fontVariantNumeric: "tabular-nums", lineHeight: "18px" }}>
      <Box component="svg" viewBox="0 0 8 8" aria-hidden="true" sx={{ width: 8, height: 8, flex: "0 0 8px", display: "block", fill: "currentColor" }}>
        <circle cx="4" cy="4" r="4" />
      </Box>
      {showLabel ? label : count > 0 ? count > 99 ? "99+" : count : null}
    </Box>
  </Tooltip>;
}
