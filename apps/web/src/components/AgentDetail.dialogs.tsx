import { Typography } from "@mui/material";
import type { ComponentProps } from "react";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { AgentOrganizationDialog, AgentRenameDialog } from "./AgentDetail.parts";
import { ConfirmDialog } from "./ConfirmationDialogs";

interface AgentDetailDialogsProps {
  recheckEngine: {
    open: boolean;
    pending: boolean;
    error?: string;
    onCancel(): void;
    onConfirm(): void;
  };
  deletion: ComponentProps<typeof AgentDeletionDialog>;
  rename: ComponentProps<typeof AgentRenameDialog>;
  organization: ComponentProps<typeof AgentOrganizationDialog>;
}

export function AgentDetailDialogs({
  recheckEngine,
  deletion,
  rename,
  organization,
}: AgentDetailDialogsProps): JSX.Element {
  return (
    <>
      <ConfirmDialog
        open={recheckEngine.open}
        title="Test Provider Access?"
        confirmLabel="Test Access"
        pending={recheckEngine.pending}
        error={recheckEngine.error}
        onCancel={recheckEngine.onCancel}
        onConfirm={recheckEngine.onConfirm}
      >
        <Typography sx={{ pt: 1 }}>
          This sends one minimal subscription-backed request to verify that the
          provider is available.
        </Typography>
      </ConfirmDialog>
      <AgentDeletionDialog {...deletion} />
      <AgentRenameDialog {...rename} />
      <AgentOrganizationDialog {...organization} />
    </>
  );
}
