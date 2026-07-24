import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import TagIcon from "@mui/icons-material/Tag";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import type { MessageDto, OperatorProfileDto } from "@ponderosa/core";
import { agentMentionHandle } from "../../mentions";
import { CopyMessageButton } from "../CopyMessageButton";
import { MessageDeliveryStatus } from "../MessageDeliveryStatus";
import { ChatMessageFrame } from "./ChatMessageFrame";
import { ChatSurface } from "./ChatSurface";
import { ChatMessageBody, CommunicationDocumentCard, chatMessageLayoutKey, individualChatSenderLabel, linkPreviewScopeForMessage } from "./ChatMessages";
import type { LinkPreviewScope } from "./ChatMessages";

function CompletedWorkDurationStatus({ agentName, label }: { agentName: string; label: string }): JSX.Element {
  return <Box
    role="status"
    aria-label={`${agentName} completed work. ${label}.`}
    sx={{ display: "flex", width: "fit-content", alignItems: "center", minHeight: 28, maxWidth: "100%", mt: 0.35, px: 0.75, py: 0.25, borderRadius: 999, color: "success.main", bgcolor: "action.hover" }}
  >
    <CheckCircleOutlineIcon sx={{ mr: 0.5, fontSize: 16, flex: "0 0 auto" }} />
    <Typography variant="caption" component="span" sx={{ color: "text.secondary", fontWeight: 650, overflowWrap: "anywhere", textAlign: "right" }}>{label}</Typography>
  </Box>;
}

export function ChatPane({
  messages,
  agentName = "Agent",
  agentNameForId,
  agentIdForHandle,
  onOpenAgent,
  onOpenBroadcast,
  onReply,
  onMentionAgent,
  onScrollPositionChange,
  previewScope,
  scrollStorageKey,
  operatorProfile,
  projectId,
  completedWorkDurationLabel,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: {
  messages: MessageDto[];
  agentName?: string;
  agentNameForId?(agentId: string): string | undefined;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(message: MessageDto): void;
  onReply?(message: MessageDto): void;
  onMentionAgent?(): void;
  onScrollPositionChange?(element: HTMLElement, nearBottom: boolean): void;
  previewScope?: LinkPreviewScope;
  scrollStorageKey?: string;
  operatorProfile?: OperatorProfileDto;
  projectId?: string;
  /** Authoritative finalized duration for the exact Run that authored a message. */
  completedWorkDurationLabel?(message: MessageDto): string | undefined;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
}): JSX.Element {
  const chatMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const messageLayoutKey = chatMessageLayoutKey(chatMessages);

  return (
    <ChatSurface
      layout="agent"
      layoutKey={messageLayoutKey}
      follow={{ kind: "latest", ...(scrollStorageKey ? { storageKey: scrollStorageKey } : {}), onPositionChange: onScrollPositionChange }}
      history={{ kind: "cursor", hasEarlier: hasOlder, loading: loadingOlder, onLoadEarlier: () => onLoadOlder?.() }}
      empty="Send a message to this agent to start the conversation."
    >
      {chatMessages.map((message) => {
        const visibleAgentName = message.authorAgentId
          ? agentNameForId?.(message.authorAgentId) ?? "Agent"
          : agentName;
        const senderLabel = message.role === "user" && operatorProfile
          ? operatorProfile.displayName
          : individualChatSenderLabel(message.role, visibleAgentName);
        const fromUser = message.role === "user";
        const workDurationLabel = message.role === "assistant" ? completedWorkDurationLabel?.(message) : undefined;
        return <ChatMessageFrame
          key={message.id}
          message={{
            id: `message-${message.id}`,
            author: fromUser
              ? { kind: "operator", profile: operatorProfile }
              : { kind: "agent", name: senderLabel },
            createdAt: message.createdAt,
            reply: message.replyTo ? {
              text: message.replyTo.text,
              onOpen: () => {
                const target = document.getElementById(`message-${message.replyTo!.messageId}`);
                target?.scrollIntoView({ behavior: "smooth", block: "center" });
                target?.focus({ preventScroll: true });
              },
            } : undefined,
            body: <ChatMessageBody
              text={message.document
                ? message.text.replace(/^(?:Full response|Full message):\s*ponderosa:\/\/artifact\/\S+\s*$/iu, "")
                : message.text}
              citations={message.citations}
              collapseLongMessage={fromUser}
              compactMarkdown
              agentIdForHandle={agentIdForHandle}
              agentMentionForHandle={(handle) => {
                const binding = message.agentMentions?.find((item) => item.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());
                const title = binding ? agentNameForId?.(binding.agentId) : undefined;
                return binding && title ? { agentId: binding.agentId, label: agentMentionHandle(title) } : undefined;
              }}
              operatorHandle={operatorProfile?.handle}
              onOpenAgent={onOpenAgent}
              onOpenBroadcast={message.role === "assistant" && message.conversationId && message.communicationEventId && /^\s*#broadcast(?:\s|$)/iu.test(message.text)
                ? () => onOpenBroadcast?.(message)
                : undefined}
              previewScope={linkPreviewScopeForMessage(message, previewScope)}
              projectId={projectId ?? previewScope?.projectId}
            />,
            afterBody: <>
              {message.document ? <CommunicationDocumentCard document={message.document} /> : null}
            </>,
            attachments: message.attachments,
            attachmentDensity: "compact",
            belowBody: workDurationLabel ? <CompletedWorkDurationStatus agentName={senderLabel} label={workDurationLabel} /> : undefined,
            status: message.role === "user" && message.deliveryReceipts?.length
              ? <MessageDeliveryStatus
                  projectId={projectId ?? previewScope?.projectId}
                  receipts={message.deliveryReceipts}
                  recipientName={(agentId) => agentNameForId?.(agentId) ?? agentName}
                  onOpenAgent={onOpenAgent}
                />
              : undefined,
            actions: <>
              {message.role === "assistant" && onMentionAgent ? <Tooltip title={`Mention ${senderLabel}`}><IconButton size="small" aria-label={`Mention ${senderLabel}`} onClick={onMentionAgent}><TagIcon fontSize="inherit" /></IconButton></Tooltip> : null}
              <CopyMessageButton text={message.text} />
            </>,
          }}
        />;
      })}
    </ChatSurface>
  );
}
