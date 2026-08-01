import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import type {
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { ConfirmDialog, ResourceDeletionDialog } from "./ConfirmationDialogs";
import { ImportAgentDialog } from "./ImportAgentDialog";

interface ConversationDialogsProps {
  conversation: ConversationDto;
  engines: EngineDto[];
  importOpen: boolean;
  stopConfirmation?: {
    targets: { agentId: string; runId: string }[];
    names: string;
  };
  renameOpen: boolean;
  renameValue: string;
  renamePending: boolean;
  renameError?: string;
  deleteOpen: boolean;
  deletePending: boolean;
  deleteError?: string;
  onImportClose(): void;
  onImported(agentId: string): void;
  onStopCancel(): void;
  onStopConfirm(
    targets: { agentId: string; runId: string }[],
    names: string,
  ): void;
  onRenameClose(): void;
  onRenameValueChange(value: string): void;
  onRename(): void;
  onDeleteClose(): void;
  onDelete(): void;
}

export function ConversationDialogs({
  conversation,
  engines,
  importOpen,
  stopConfirmation,
  renameOpen,
  renameValue,
  renamePending,
  renameError,
  deleteOpen,
  deletePending,
  deleteError,
  onImportClose,
  onImported,
  onStopCancel,
  onStopConfirm,
  onRenameClose,
  onRenameValueChange,
  onRename,
  onDeleteClose,
  onDelete,
}: ConversationDialogsProps): JSX.Element {
  return (
    <>
      <ImportAgentDialog
        open={importOpen}
        projectId={conversation.projectId}
        engines={engines}
        conversations={[conversation]}
        initialConversationId={conversation.id}
        onClose={onImportClose}
        onImported={onImported}
      />

      <ConfirmDialog
        open={Boolean(stopConfirmation)}
        title="Stop Operation Tree?"
        confirmLabel="Stop Operation"
        onCancel={onStopCancel}
        onConfirm={() => {
          if (stopConfirmation)
            onStopConfirm(stopConfirmation.targets, stopConfirmation.names);
        }}
      >
        <Typography sx={{ pt: 1 }}>
          Stop work for {stopConfirmation?.names}? Partial output from every
          affected Agent will remain visible.
        </Typography>
      </ConfirmDialog>

      <Dialog open={renameOpen} onClose={onRenameClose} fullWidth maxWidth="xs">
        <DialogTitle>Rename Project chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Project chat name"
            value={renameValue}
            onChange={event => onRenameValueChange(event.target.value)}
            sx={{ mt: 1 }}
          />
          {renameError ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {renameError}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={onRenameClose}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!renameValue.trim() || renamePending}
            onClick={onRename}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <ResourceDeletionDialog
        open={deleteOpen}
        resourceType="Chat"
        resourceName={conversation.title}
        pendingLabel="Deleting…"
        pending={deletePending}
        error={deleteError}
        onCancel={onDeleteClose}
        onConfirm={onDelete}
      >
        <Alert severity="warning">
          This permanently deletes the Chat and its history. Assigned Agents
          are preserved and become unassigned. Related Triggers and pending
          work are cancelled. Stop any active assigned Agent before deleting.
        </Alert>
      </ResourceDeletionDialog>
    </>
  );
}
