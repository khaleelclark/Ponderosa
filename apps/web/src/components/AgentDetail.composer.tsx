import {MutationErrorDetails} from "./MutationNotifications";
import type {WorkspaceReadIssue} from "../workspaceAvailability";
import {WorkspaceQueryError} from "./WorkspaceQueryError";
import { Alert, Button } from "@mui/material";
import { providerCommandResultSx } from "../providerCommandResult";
import type {
  ProviderUsageStateDto,
  QueuedConversationMessageDto,
} from "@ponderosa/core";
import type { ComposerProps } from "./chat/Composer";
import { Composer } from "./chat/Composer";
import { ChatComposerDock } from "./chat/ChatComposerDock";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { AgentProviderUsageCard } from "./ProviderUsageCenter";

interface AgentDetailComposerProps {
  visible: boolean;
  queuedMessageNotice?: string;
  queuedRead?: WorkspaceReadIssue;
  queuedMessageFailure?: { error: Error; retry(): void };
  cancellationError?: string;
  providerUsageState?: ProviderUsageStateDto;
  agentId: string;
  conversationId?: string;
  onCloseProviderUsage(): void;
  queuedMessages: QueuedConversationMessageDto[];
  attachmentNamesForQueuedMessage?(message: QueuedConversationMessageDto): string[] | undefined;
  queuedBusy: boolean;
  onSteerQueued(message: QueuedConversationMessageDto): Promise<unknown>;
  onEditQueued(
    message: QueuedConversationMessageDto,
    text: string,
  ): Promise<unknown>;
  onDeleteQueued(message: QueuedConversationMessageDto): Promise<unknown>;
  composer: ComposerProps;
}

export function AgentDetailComposer({
  visible,
  queuedMessageNotice,
  queuedRead,
  queuedMessageFailure,
  cancellationError,
  providerUsageState,
  agentId,
  conversationId,
  onCloseProviderUsage,
  queuedMessages,
  attachmentNamesForQueuedMessage,
  queuedBusy,
  onSteerQueued,
  onEditQueued,
  onDeleteQueued,
  composer,
}: AgentDetailComposerProps): JSX.Element {
  return (
    <ChatComposerDock visible={visible}>
      {queuedMessageNotice ? <Alert severity="info" role="status" aria-live="polite" tabIndex={0} sx={providerCommandResultSx}>{queuedMessageNotice}</Alert> : null}
      <MutationErrorDetails title="Run Control Needs Review" error={cancellationError}/>
      {queuedRead&&<WorkspaceQueryError read={queuedRead}/>}
      {queuedMessageFailure&&<details><summary>Queue Action Needs Attention</summary>{queuedMessageFailure.error.message}<Button onClick={queuedMessageFailure.retry}>Retry Action</Button></details>}
      {providerUsageState ? (
        <AgentProviderUsageCard
          agentId={agentId}
          initialState={providerUsageState}
          onClose={onCloseProviderUsage}
        />
      ) : null}
      {!composer.assistantMessages&&<QueuedMessageTray
        messages={queuedMessages}
        scope={composer.conversationDraftId}
        conversationId={conversationId}
        attachmentNamesForMessage={attachmentNamesForQueuedMessage}
        busy={queuedBusy}
        onSteer={onSteerQueued}
        onEdit={onEditQueued}
        onDelete={onDeleteQueued}
      />}
      <Composer {...composer} />
    </ChatComposerDock>
  );
}
