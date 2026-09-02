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
}> = {
  enabled: { label: "Enabled", color: "success" },
  running: { label: "Running", color: "info" },
  waiting: { label: "Waiting", color: "warning" },
  idle: { label: "Idle", color: "default" },
  completed: { label: "Completed", color: "success" },
  needs_attention: { label: "Needs attention", color: "error" },
  blocked: { label: "Blocked", color: "warning" },
  failed: { label: "Failed", color: "error" },
  disabled: { label: "Disabled", color: "default" },
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
      variant="filled"
      aria-label={detail ? `${visibleLabel}. ${detail}` : visibleLabel}
      title={detail}
    />
  );
}
