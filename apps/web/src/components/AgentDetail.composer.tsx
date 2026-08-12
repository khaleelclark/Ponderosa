import { Alert } from "@mui/material";
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
  sendError?: string;
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
  sendError,
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
      {sendError ? (
        <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
          {sendError}
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
