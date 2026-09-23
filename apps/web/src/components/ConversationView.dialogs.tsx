import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from "@mui/material";
import type {
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { ActiveOperationStopDialog } from "./ActiveOperationStopDialog";

interface ConversationDialogsProps {
  conversation: ConversationDto;
  engines: EngineDto[];
  importOpen: boolean;
  stopPending: boolean;
  stopError?: string;
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
  stopPending,
  stopError,
  stopConfirmation,
  renameOpen,
  renameValue,
  renamePending,
  renameError,
  deleteOpen,
  deletePending,
  deleteError,
  onImportClose,
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
      />

      <ActiveOperationStopDialog
        confirmation={stopConfirmation}
        pending={stopPending}
        error={stopError}
        onCancel={onStopCancel}
        onConfirm={targets => onStopConfirm(
          targets,
          stopConfirmation?.names ?? "the selected Agents",
        )}
      />

      <Dialog open={renameOpen} onClose={onRenameClose} fullWidth maxWidth="xs">
        <DialogTitle>Rename Chat</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Chat name"
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
          are preserved and become unassigned. Related Automations and pending
          work are cancelled. Stop any active assigned Agent before deleting.
        </Alert>
      </ResourceDeletionDialog>
    </>
  );
}
