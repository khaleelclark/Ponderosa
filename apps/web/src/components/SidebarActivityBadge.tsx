import { Box, Tooltip } from "@mui/material";
import { agentDisplayStatus, AGENT_DISPLAY_STATUS_LABELS, type AgentHealthDto, type WorkspaceActivityCountDto } from "@ponderosa/core";
import { SemanticStatusCircle, semanticStatusColorToken } from "./SemanticStatus";

export function SidebarActivityBadge({ activity, agent, fresh = false, showLabel = false }: { activity?: WorkspaceActivityCountDto; agent?: { title: string; health?: AgentHealthDto }; fresh?: boolean; showLabel?: boolean }) {
  const status = agent ? agent.health ? agentDisplayStatus(agent.health) : "unknown" : activity?.status ?? "unknown";
  const label = status === "unknown" ? "Unknown" : AGENT_DISPLAY_STATUS_LABELS[status];
  const detail = agent ? `${agent.title} · ${label}${fresh ? "" : " · Status updates delayed"}` : activity
    ? `${label}; ${activity.runningCount} working, ${activity.waitingCount} waiting, ${activity.decisionCount} need decision, ${activity.recoveryCount} recovering, ${activity.errorCount} errors, ${activity.idleCount} idle, ${activity.unknownCount} unknown. Last confirmed ${activity.lastConfirmedAt ?? "unavailable"}${fresh ? "" : "; updates may be delayed"}.`
    : "Agent status unknown; no confirmed status available.";
  const count = agent ? 0 : activity?.activeCount ?? 0;

  return <Tooltip title={detail}>
    <Box component="span" role="img" data-sidebar-column="activity" data-agent-status={status} aria-label={detail} tabIndex={0}
      sx={{ display: "inline-flex", alignItems: "center", gap: .5, flexShrink: 0, color: theme => semanticStatusColorToken(status === "unknown" ? "idle" : status, theme.palette.mode), fontSize: 11, fontVariantNumeric: "tabular-nums", lineHeight: "18px" }}>
      <SemanticStatusCircle />
      {showLabel ? label : count > 0 ? count > 99 ? "99+" : count : null}
    </Box>
  </Tooltip>;
}
