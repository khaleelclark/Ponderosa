import { TextInputDialog } from "./ConfirmationDialogs";
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
  onRename(value: string): void;
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

      <TextInputDialog
        open={renameOpen}
        title="Rename Chat"
        label="Chat name"
        initialValue={renameValue}
        confirmLabel="Save"
        pendingLabel="Saving…"
        pending={renamePending}
        error={renameError}
        validate={value => value.trim() ? undefined : "Enter a Chat name."}
        onCancel={onRenameClose}
        onConfirm={value => onRename(value.trim())}
      />

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
