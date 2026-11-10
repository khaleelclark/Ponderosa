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
      {cancellationError ? (
        <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
          {cancellationError}
        </Alert>
      ) : null}
      {queuedRead&&<WorkspaceQueryError read={queuedRead}/>}
      {queuedMessageFailure&&<details><summary>Queue action needs attention</summary>{queuedMessageFailure.error.message}<Button onClick={queuedMessageFailure.retry}>Retry action</Button></details>}
      {providerUsageState ? (
        <AgentProviderUsageCard
          agentId={agentId}
          initialState={providerUsageState}
          onClose={onCloseProviderUsage}
        />
      ) : null}
      <QueuedMessageTray
        messages={queuedMessages}
        queueReviewHref={composer.assistantMessages?composer.queueReviewHref:undefined}
        scope={composer.conversationDraftId}
        attachmentNamesForMessage={attachmentNamesForQueuedMessage}
        busy={queuedBusy}
        onSteer={onSteerQueued}
        onEdit={onEditQueued}
        onDelete={onDeleteQueued}
      />
      <Composer {...composer} />
    </ChatComposerDock>
  );
}
