import { AGENT_DISPLAY_STATUS_LABELS } from "@ponderosa/core";
import { Box, Chip, type ChipProps } from "@mui/material";

export type SemanticStatusKind =
  | "unknown"
  | "working"
  | "needs_decision"
  | "recovering"
  | "error"
  | "enabled"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "needs_attention"
  | "blocked"
  | "failed"
  | "disabled";

const STATUS_PRESENTATION: Record<SemanticStatusKind, {
  label: string;
  color: NonNullable<ChipProps["color"]>;
}> = {
  unknown: { label: "Unknown", color: "default" },
  working: { label: AGENT_DISPLAY_STATUS_LABELS.working, color: "success" },
  needs_decision: { label: AGENT_DISPLAY_STATUS_LABELS.needs_decision, color: "warning" },
  recovering: { label: AGENT_DISPLAY_STATUS_LABELS.recovering, color: "info" },
  error: { label: AGENT_DISPLAY_STATUS_LABELS.error, color: "error" },
  enabled: { label: "Enabled", color: "success" },
  running: { label: "Running", color: "info" },
  waiting: { label: AGENT_DISPLAY_STATUS_LABELS.waiting, color: "warning" },
  idle: { label: AGENT_DISPLAY_STATUS_LABELS.idle, color: "default" },
  completed: { label: "Completed", color: "success" },
  needs_attention: { label: "Needs attention", color: "error" },
  blocked: { label: "Blocked", color: "warning" },
  failed: { label: "Failed", color: "error" },
  disabled: { label: "Disabled", color: "default" },
};

export function semanticStatusPresentation(kind: SemanticStatusKind) {
  return STATUS_PRESENTATION[kind];
}

export function semanticStatusColorToken(kind: SemanticStatusKind, mode: "light" | "dark" = "dark"):
  | "#A85410"
  | "#D98C45"
  | "success.main"
  | "info.main"
  | "warning.main"
  | "error.main"
  | "text.disabled" {
  if (kind === "needs_decision") return mode === "light" ? "#A85410" : "#D98C45";
  const color = STATUS_PRESENTATION[kind].color;
  return (color === "default" ? "text.disabled" : `${color}.main`) as
    | "success.main"
    | "info.main"
    | "warning.main"
    | "error.main"
    | "text.disabled";
}

export function semanticAgentStatus(status: string): SemanticStatusKind {
  if (["running", "preparing", "compacting"].includes(status)) return "running";
  if (status === "waiting") return "waiting";
  if (["blocked", "interrupted"].includes(status)) return "blocked";
  if (["needs_decision", "stalled"].includes(status)) return "needs_attention";
  if (["failed", "cancelled"].includes(status)) return "failed";
  if (status === "completed") return "completed";
  return "idle";
}

/** Shared fixed-size sidebar circle; semantic color comes from its owner. */
export function SemanticStatusCircle(): JSX.Element {
  return <Box component="svg" viewBox="0 0 8 8" aria-hidden="true" sx={{ width: 8, height: 8, flex: "0 0 8px", display: "block", fill: "currentColor" }}>
    <circle cx="4" cy="4" r="4" />
  </Box>;
}

export function SemanticStatus({
  status,
  label,
  accessibleLabel,
  detail,
  size = "small",
}: {
  status: SemanticStatusKind;
  label?: string;
  accessibleLabel?: string;
  detail?: string;
  size?: "small" | "medium";
}): JSX.Element {
  const presentation = semanticStatusPresentation(status);
  const visibleLabel = label ?? presentation.label;
  return (
    <Chip
      size={size}
      label={visibleLabel}
      color={presentation.color}
      sx={theme => status === "needs_decision"
        ? { bgcolor: semanticStatusColorToken(status, theme.palette.mode), color: theme.palette.mode === "dark" ? "#18130C" : "#FFFFFF" }
        : status === "idle" || status === "unknown"
          ? { bgcolor: semanticStatusColorToken(status), color: theme.palette.getContrastText(theme.palette.text.disabled) }
          : {}}
      variant="filled"
      aria-label={accessibleLabel ?? visibleLabel}
      title={detail}
    />
  );
}
