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
import { AddAgentsFlow } from "./AddAgentsFlow";
import { ActiveOperationStopDialog } from "./ActiveOperationStopDialog";
import { ChatDeletionDialog } from "./ChatDeletionDialog";

interface ConversationDialogsProps {
  conversation: ConversationDto;
  engines: EngineDto[];
  addAgentsOpen: boolean;
  onCreateAgent(): void;
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
  onAddAgentsClose(): void;
  onStopCancel(): void;
  onStopConfirm(
    targets: { agentId: string; runId: string }[],
    names: string,
  ): void;
  onRenameClose(): void;
  onRenameValueChange(value: string): void;
  onRename(): void;
  onDeleteClose(): void;
  onDelete(expectedAgentIds: string[]): void;
}

export function ConversationDialogs({
  conversation,
  engines,
  addAgentsOpen,
  onCreateAgent,
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
  onAddAgentsClose,
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
      <AddAgentsFlow
        open={addAgentsOpen}
        fixedProjectId={conversation.projectId}
        initialConversation={conversation}
        conversations={[conversation]}
        engines={engines}
        onCreate={onCreateAgent}
        onClose={onAddAgentsClose}
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

      <ChatDeletionDialog
        open={deleteOpen}
        conversation={conversation}
        pending={deletePending}
        error={deleteError}
        onClose={onDeleteClose}
        onDelete={onDelete}
      />
    </>
  );
}
