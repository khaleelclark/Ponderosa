import { Typography } from "@mui/material";
import { ConfirmDialog } from "./ConfirmationDialogs";

export interface ActiveOperationStopConfirmation {
  targets: { agentId: string; runId: string }[];
  names: string;
}

export function ActiveOperationStopDialog({
  confirmation,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  confirmation?: ActiveOperationStopConfirmation;
  pending: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(targets: { agentId: string; runId: string }[]): void;
}): JSX.Element {
  return <ConfirmDialog
    open={Boolean(confirmation)}
    pending={pending}
    pendingLabel="Cancelling…"
    error={error}
    title="Stop Operation Tree?"
    confirmLabel="Stop Operation"
    onCancel={onCancel}
    onConfirm={() => {
      if (confirmation) onConfirm(confirmation.targets);
    }}
  >
    <Typography sx={{ pt: 1 }}>
      Stop work for {confirmation?.names}? Partial output from every affected
      Agent will remain visible.
    </Typography>
  </ConfirmDialog>;
}
