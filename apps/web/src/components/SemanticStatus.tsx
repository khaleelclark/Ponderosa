import { Chip, type ChipProps } from "@mui/material";

export type SemanticStatusKind =
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
  variant: NonNullable<ChipProps["variant"]>;
}> = {
  enabled: { label: "Enabled", color: "success", variant: "outlined" },
  running: { label: "Running", color: "info", variant: "filled" },
  waiting: { label: "Waiting", color: "warning", variant: "outlined" },
  idle: { label: "Idle", color: "default", variant: "outlined" },
  completed: { label: "Completed", color: "success", variant: "filled" },
  needs_attention: { label: "Needs attention", color: "error", variant: "outlined" },
  blocked: { label: "Blocked", color: "warning", variant: "filled" },
  failed: { label: "Failed", color: "error", variant: "filled" },
  disabled: { label: "Disabled", color: "default", variant: "outlined" },
};

export function semanticStatusPresentation(kind: SemanticStatusKind) {
  return STATUS_PRESENTATION[kind];
}

export function semanticStatusColorToken(kind: SemanticStatusKind):
  | "success.main"
  | "info.main"
  | "warning.main"
  | "error.main"
  | "text.disabled" {
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

export function SemanticStatus({
  status,
  label,
  detail,
  size = "small",
}: {
  status: SemanticStatusKind;
  label?: string;
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
      variant={presentation.variant}
      aria-label={detail ? `${visibleLabel}. ${detail}` : visibleLabel}
      title={detail}
    />
  );
}
