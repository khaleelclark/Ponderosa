import { Typography } from "@mui/material";
import type { ComponentProps } from "react";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { ImportAgentDialog } from "./ImportAgentDialog";
import {
  AgentMembershipDialog,
  AgentOrganizationDialog,
  AgentRenameDialog,
} from "./AgentDetail.parts";
import { ConfirmDialog } from "./ConfirmationDialogs";

interface AgentDetailDialogsProps {
  elevatedCopy: {
    open: boolean;
    onCancel(): void;
    onConfirm(): void;
  };
  recheckEngine: {
    open: boolean;
    pending: boolean;
    error?: string;
    onCancel(): void;
    onConfirm(): void;
  };
  deletion: ComponentProps<typeof AgentDeletionDialog>;
  importAgent: ComponentProps<typeof ImportAgentDialog>;
  rename: ComponentProps<typeof AgentRenameDialog>;
  membership: ComponentProps<typeof AgentMembershipDialog>;
  organization: ComponentProps<typeof AgentOrganizationDialog>;
}

export function AgentDetailDialogs({
  elevatedCopy,
  recheckEngine,
  deletion,
  importAgent,
  rename,
  membership,
  organization,
}: AgentDetailDialogsProps): JSX.Element {
  return (
    <>
      <ConfirmDialog
        open={elevatedCopy.open}
        title="Copy Elevated Agent Permissions?"
        confirmLabel="Copy Agent"
        onCancel={elevatedCopy.onCancel}
        onConfirm={elevatedCopy.onConfirm}
      >
        <Typography sx={{ pt: 1 }}>
          This Agent can automatically delete or reorganize descendants. The
          copied Agent will retain those elevated organization permissions.
        </Typography>
      </ConfirmDialog>
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
      <ImportAgentDialog {...importAgent} />
      <AgentRenameDialog {...rename} />
      <AgentMembershipDialog {...membership} />
      <AgentOrganizationDialog {...organization} />
    </>
  );
}

