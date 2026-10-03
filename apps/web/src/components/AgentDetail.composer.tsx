import { Alert, Button } from "@mui/material";
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
  queuedMessageFailure?: { error: Error; retry(): void };
  cancellationError?: string;
  providerUsageState?: ProviderUsageStateDto;
  agentId: string;
  onCloseProviderUsage(): void;
  queuedMessages: QueuedConversationMessageDto[];
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
  queuedMessageFailure,
  cancellationError,
  providerUsageState,
  agentId,
  onCloseProviderUsage,
  queuedMessages,
  queuedBusy,
  onSteerQueued,
  onEditQueued,
  onDeleteQueued,
  composer,
}: AgentDetailComposerProps): JSX.Element {
  return (
    <ChatComposerDock visible={visible}>
      {queuedMessageNotice ? (
        <Alert
          severity="info"
          role="status"
          aria-live="polite"
          sx={{ mx: 1.5, mt: 1 }}
        >
          {queuedMessageNotice}
        </Alert>
      ) : null}
      {cancellationError ? (
        <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
          {cancellationError}
        </Alert>
      ) : null}
      {queuedMessageFailure ? (
        <Alert
          severity="error"
          sx={{ mx: 1.5, mt: 1 }}
          action={<Button color="inherit" size="small" onClick={queuedMessageFailure.retry}>Retry</Button>}
        >
          Queued messages could not be updated. {queuedMessageFailure.error.message}
        </Alert>
      ) : null}
      {providerUsageState ? (
        <AgentProviderUsageCard
          agentId={agentId}
          initialState={providerUsageState}
          onClose={onCloseProviderUsage}
        />
      ) : null}
      <QueuedMessageTray
        messages={queuedMessages}
        busy={queuedBusy}
        onSteer={onSteerQueued}
        onEdit={onEditQueued}
        onDelete={onDeleteQueued}
      />
      <Composer {...composer} />
    </ChatComposerDock>
  );
}
