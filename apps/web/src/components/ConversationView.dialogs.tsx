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
  ConversationMessageDto,
  EngineDto,
} from "@ponderosa/core";
import { ConfirmDialog } from "./ConfirmationDialogs";
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
  editingMessage?: ConversationMessageDto;
  correctionText: string;
  correctionPending: boolean;
  correctionError?: string;
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
  onCorrectionClose(): void;
  onCorrectionTextChange(value: string): void;
  onCorrectMessage(message: ConversationMessageDto): void;
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
  editingMessage,
  correctionText,
  correctionPending,
  correctionError,
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
  onCorrectionClose,
  onCorrectionTextChange,
  onCorrectMessage,
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

      <Dialog
        open={Boolean(editingMessage)}
        onClose={() => {
          if (!correctionPending) onCorrectionClose();
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Edit Message</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            The original remains in append-only history. Broadcast edits update
            the shared note; edits to a delivered request queue a correction to
            its original recipient.
          </Alert>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Message"
            value={correctionText}
            onChange={event => onCorrectionTextChange(event.target.value)}
          />
          {correctionError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {correctionError}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={onCorrectionClose} disabled={correctionPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!correctionText.trim() || correctionPending}
            onClick={() => {
              if (editingMessage) onCorrectMessage(editingMessage);
            }}
          >
            Save Edit
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          if (!deletePending) onDeleteClose();
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete Project chat?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes{" "}
            <Box component="strong">{conversation.title}</Box> and its chat
            history. Its agents are preserved in the Agents tab as unassigned
            agents. This cannot be undone.
          </Typography>
          {deleteError ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {deleteError}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={onDeleteClose} disabled={deletePending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deletePending}
            onClick={onDelete}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
