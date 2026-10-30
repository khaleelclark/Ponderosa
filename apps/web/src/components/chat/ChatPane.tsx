import { Alert, Box, Button, ButtonBase, Chip } from "@mui/material";
import type {
  AgentActivityDto,
  ConversationDecisionEventDto,
  DecisionDto,
  AgentRunDto,
  MessageDto,
  OperatorProfileDto,
  ResponseFileActivityDto,
  RunOutputDto,
} from "@ponderosa/core";
import { DecisionCard } from "../decisions/DecisionCard";
import { Fragment, memo, useMemo } from "react";
import { CopyMessageButton } from "../CopyMessageButton";
import { MessageDeliveryStatus } from "../MessageDeliveryStatus";
import { MessageRequestAction } from "../MessageRequestAction";
import { buildActivityStream } from "../activity/activityStream";
import type { ActivityStreamEntry } from "../activity/activityStream";
import { AgentWorkReceipt } from "./AgentWorkReceipt";
import { hasVisibleReceiptActivity } from "./receiptActivityEntries";
import { ChatMessageFrame } from "./ChatMessageFrame";
import { LiveAgentProgress } from "./LiveAgentProgress";
import { ChatSurface } from "./ChatSurface";
import {
  ChatMessageBody,
  CommunicationDocumentCard,
  fileOwnerForMessage,
  authoredAgentMentionForHandle,
  chatMessageLayoutKey,
  communicationVisibleText,
  individualChatSenderLabel,
  linkPreviewScopeForMessage,
  resolveMessageMentionText,
  showBroadcastBadge,
  stripDocumentPrefixText,
} from "./ChatMessages";
import type { LinkPreviewScope } from "./ChatMessages";
import { projectAgentChat } from "./agentChatProjection";
import { ReadAloudControls } from "../speech/ReadAloudControls";
import { DecisionResponseMessage } from "../decisions/DecisionResponseMessage";

function CommunicationSourceLink({
  message,
  outgoing,
  onOpen,
}: {
  message: MessageDto;
  outgoing: boolean;
  onOpen(message: MessageDto): void;
}): JSX.Element | null {
  if (message.communicationIntent === "broadcast") {
    if (!showBroadcastBadge(
      message.communicationIntent,
      message.communicationEventId,
    )) return null;
    return (
      <Chip
        size="small"
        variant="outlined"
        label="Broadcast"
        clickable
        onClick={() => onOpen(message)}
        aria-label="Broadcast. Open source message."
      />
    );
  }
  const sourceLabel = outgoing ? "to Team Chat" : "via Team Chat";
  return (
    <ButtonBase
      onClick={() => onOpen(message)}
      aria-label={`${sourceLabel}. Open source message.`}
      sx={{
        minWidth: 0,
        p: 0,
        color: "text.secondary",
        borderRadius: 0.5,
        fontSize: 11.5,
        fontWeight: 500,
        lineHeight: 1.35,
        whiteSpace: "nowrap",
        "&:hover": {
          color: "primary.light",
          textDecoration: "underline",
          textUnderlineOffset: "2px",
        },
      }}
    >
      {sourceLabel}
    </ButtonBase>
  );
}

function visibleAgentMessageText(message: MessageDto): string {
  const text = stripDocumentPrefixText(
    message.text,
    Boolean(message.document),
  );
  return communicationVisibleText({
    text,
    intent: message.communicationIntent,
    fromAgent: Boolean(message.authorAgentId),
    agentMentions: message.agentMentions,
  });
}

function ChatPaneComponent({
  messages,
  decisionEvents = [],
  pendingDecisions = [],
  agentName = "Agent",
  agentNameForId,
  agentIdForHandle,
  onOpenAgent,
  onOpenMessageSource,
  onCommunicationVisible,
  onScrollPositionChange,
  previewScope,
  scrollStorageKey,
  operatorProfile,
  projectId,
  fileOwnerAgentId,
  activity = [],
  runOutput = [],
  runs = [],
  activeExecutionId,
  pausedRunId,
  projectRoot,
  onOpenFile,
  focusId,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  historyError,
}: {
  messages: MessageDto[];
  decisionEvents?: ConversationDecisionEventDto[];
  pendingDecisions?: DecisionDto[];
  agentName?: string;
  agentNameForId?(agentId: string): string | undefined;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenMessageSource?(message: MessageDto): void;
  onCommunicationVisible?(
    communicationEventId: string | undefined,
    visible: boolean,
  ): void;
  onScrollPositionChange?(element: HTMLElement, nearBottom: boolean): void;
  previewScope?: LinkPreviewScope;
  scrollStorageKey?: string;
  operatorProfile?: OperatorProfileDto;
  projectId?: string;
  fileOwnerAgentId?: string;
  activity?: AgentActivityDto[];
  runOutput?: RunOutputDto[];
  runs?: AgentRunDto[];
  activeExecutionId?: string;
  pausedRunId?: string;
  projectRoot?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  focusId?: string;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
  historyError?: string;
}): JSX.Element {
  const agentChat = useMemo(
    () => projectAgentChat(messages, runs),
    [messages, runs],
  );
  const chatMessages = agentChat.messages;
  const visibleRunIds = useMemo(
    () => new Set(agentChat.runs.map(run => run.id)),
    [agentChat.runs],
  );
  const visibleActivity = useMemo(
    () =>
      activity.filter(
        item => !item.executionId || visibleRunIds.has(item.executionId),
      ),
    [activity, visibleRunIds],
  );
  const visibleRunOutput = useMemo(
    () =>
      runOutput.filter(segment => visibleRunIds.has(segment.executionId)),
    [runOutput, visibleRunIds],
  );
  const activityEntries = useMemo(
    () =>
      buildActivityStream({
        activity: visibleActivity,
        runOutput: visibleRunOutput,
        runs: agentChat.runs,
        messages: chatMessages,
        ...(activeExecutionId && visibleRunIds.has(activeExecutionId)
          ? { activeExecutionId }
          : {}),
      }),
    [
      activeExecutionId,
      agentChat.runs,
      chatMessages,
      visibleActivity,
      visibleRunIds,
      visibleRunOutput,
    ],
  );
  const activityByRun = useMemo(() => {
    const grouped = new Map<string, ActivityStreamEntry[]>();
    let groupKey: string | undefined;
    for (const entry of activityEntries) {
      if (entry.kind === "run_header") {
        groupKey = entry.executionId ?? "unscoped";
        continue;
      }
      if (!groupKey) continue;
      const entries = grouped.get(groupKey);
      if (entries) entries.push(entry);
      else grouped.set(groupKey, [entry]);
    }
    return grouped;
  }, [activityEntries]);
  const unscopedActivity = activityByRun.get("unscoped") ?? [];
  const messageByCommunicationId = useMemo(
    () =>
      new Map(
        chatMessages.flatMap(message =>
          message.communicationEventId
            ? [[message.communicationEventId, message] as const]
            : [],
        ),
      ),
    [chatMessages],
  );
  const runPlacement = useMemo(() => {
    const lastResponseByRunId = new Map<string, MessageDto>();
    for (const message of chatMessages) {
      if (message.role !== "assistant" || !message.executionId) continue;
      const current = lastResponseByRunId.get(message.executionId);
      if (
        !current ||
        current.createdAt.localeCompare(message.createdAt) <= 0
      ) {
        lastResponseByRunId.set(message.executionId, message);
      }
    }

    const afterMessage = new Map<string, AgentRunDto[]>();
    const standalone: AgentRunDto[] = [];
    for (const run of agentChat.runs) {
      const response = lastResponseByRunId.get(run.id);
      const request = run.communicationEventId
        ? messageByCommunicationId.get(run.communicationEventId)
        : undefined;
      if (response) {
        const placedRuns = afterMessage.get(response.id);
        if (placedRuns) placedRuns.push(run);
        else afterMessage.set(response.id, [run]);
        continue;
      }

      const runEntries = activityByRun.get(run.id) ?? [];
      const hasVisibleActivity = hasVisibleReceiptActivity(runEntries, run.status);
      const representedByDeliveryStatus =
        request?.role === "user" &&
        Boolean(request.deliveryReceipts?.length) &&
        !hasVisibleActivity;
      if (!representedByDeliveryStatus) standalone.push(run);
    }
    return { afterMessage, standalone };
  }, [
    activityByRun,
    agentChat.runs,
    chatMessages,
    messageByCommunicationId,
  ]);
  const decisionCards = useMemo(() => {
    const byId = new Map(decisionEvents.filter(event => event.kind === "decision").map(event => [event.decision.id, event.decision]));
    // Pending questions remain reachable even outside the loaded history page.
    for (const decision of pendingDecisions) if (!byId.has(decision.id)) byId.set(decision.id, decision);
    return [...byId.values()];
  }, [decisionEvents, pendingDecisions]);
  const timeline = useMemo(
    () =>
      [
        ...decisionCards.map(decision => ({ kind: "decision" as const, id: `decision:${decision.id}`, createdAt: decision.createdAt, decision })),
        ...decisionEvents.filter(event => event.kind === "decision_response").map(event => ({
          kind: "decision-response" as const, id: event.id, createdAt: event.createdAt, event,
        })),
        ...chatMessages.map(message => ({
          kind: "message" as const,
          id: `message:${message.id}`,
          createdAt: message.createdAt,
          message,
        })),
        ...runPlacement.standalone.map(run => ({
          kind: "run" as const,
          id: `run:${run.id}`,
          createdAt: run.startedAt,
          run,
        })),
        ...(unscopedActivity.length
          ? [{
              kind: "unscoped" as const,
              id: "run:unscoped",
              createdAt: unscopedActivity[0]!.createdAt,
            }]
          : []),
      ].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          (left.kind === right.kind
            ? left.id.localeCompare(right.id)
            : left.kind === "message"
              ? -1
              : 1),
      ),
    [chatMessages, decisionCards, decisionEvents, runPlacement.standalone, unscopedActivity],
  );
  const latestTimelineItem = timeline.at(-1);
  const latestActivity = activityEntries.at(-1);
  const latestRunOutputSeq = visibleRunOutput.reduce(
    (latest, item) => Math.max(latest, item.sourceSeqEnd),
    0,
  );
  const messageLayoutKey = [
    chatMessageLayoutKey(chatMessages),
    timeline.length,
    agentChat.runs.length,
    latestTimelineItem?.id ?? "none",
    latestActivity?.id ?? "none",
    latestRunOutputSeq,
  ].join(":");

  return (
    <ChatSurface
      showOutgoingMessage
      canonicalCommunicationIds={chatMessages.map(message => message.communicationEventId)}
      layout="agent"
      layoutKey={messageLayoutKey}
      follow={{
        kind: "latest",
        ...(scrollStorageKey ? { storageKey: scrollStorageKey } : {}),
        onPositionChange: onScrollPositionChange,
      }}
      history={{
        kind: "cursor",
        hasEarlier: hasOlder,
        loading: loadingOlder,
        onLoadEarlier: () => onLoadOlder?.(),
      }}
      beforeMessages={historyError ? (
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" onClick={() => onLoadOlder?.()}>Retry</Button>}
          sx={{ m: 1.5 }}
        >
          {historyError}
        </Alert>
      ) : null}
      empty="Send a message to this agent to start the conversation."
    >
      {timeline.map(item => {
        if (item.kind === "decision") return <Box key={item.id} id={item.id} tabIndex={-1}
          sx={{ minWidth: 0, mb: 1.5, outlineOffset: 2 }}><DecisionCard decision={item.decision} /></Box>;
        if (item.kind === "decision-response") return <DecisionResponseMessage key={item.id}
          event={item.event} operatorProfile={operatorProfile} onOpenAgent={onOpenAgent} />;
        if (item.kind === "run") {
          return (
            <AgentWorkReceipt
              key={item.id}
              agentName={agentName}
              run={item.run}
              paused={item.run.id === pausedRunId}
              entries={activityByRun.get(item.run.id) ?? []}
              projectId={projectId}
              projectRoot={projectRoot}
              onOpenFile={onOpenFile}
              focusId={focusId}
              active={item.run.id === activeExecutionId}
            />
          );
        }
        if (item.kind === "unscoped") {
          return (
            <AgentWorkReceipt
              key={item.id}
              agentName={agentName}
              entries={unscopedActivity}
              projectId={projectId}
              projectRoot={projectRoot}
              onOpenFile={onOpenFile}
              focusId={focusId}
            />
          );
        }
        const message = item.message;
        const visibleAgentName = message.authorAgentId
          ? (agentNameForId?.(message.authorAgentId) ?? "Agent")
          : agentName;
        const senderLabel =
          message.role === "user" && operatorProfile
            ? operatorProfile.displayName
            : individualChatSenderLabel(message.role, visibleAgentName);
        const fromUser = message.role === "user";
        const fromSourceChat =
          (message.communicationIntent === "collaboration" ||
            message.communicationIntent === "broadcast") &&
          Boolean(
            message.conversationId &&
              message.communicationEventId &&
              onOpenMessageSource,
          );
        const outgoingTeamMessage =
          fromSourceChat && message.authorAgentId === message.agentId;
        const receivedFromAgent =
          message.communicationIntent === "collaboration" &&
          Boolean(
            message.authorAgentId &&
              message.authorAgentId !== message.agentId,
          );
        const receivedInput = fromUser || receivedFromAgent;
        const visibleText = visibleAgentMessageText(message);
        const readAloudText = resolveMessageMentionText(
          visibleText,
          message.agentMentions,
        );
        const attachedRuns = runPlacement.afterMessage.get(message.id) ?? [];
        return (
          <Fragment key={item.id}>
            <ChatMessageFrame
              message={{
              id: `message-${message.id}`,
              author: fromUser
                ? { kind: "operator", profile: operatorProfile }
                : receivedFromAgent
                  ? {
                      kind: "inbound_agent",
                      name: senderLabel,
                      ...(message.authorAgentId && onOpenAgent
                        ? {
                            onOpen: () =>
                              onOpenAgent(message.authorAgentId!),
                          }
                        : {}),
                    }
                : {
                    kind: "agent",
                    name: senderLabel,
                    ...(message.authorAgentId && onOpenAgent
                      ? {
                          onOpen: () =>
                            onOpenAgent(message.authorAgentId!),
                        }
                      : {}),
                  },
              createdAt: message.createdAt,
              onVisible: onCommunicationVisible
                ? (visible) =>
                    onCommunicationVisible(
                      message.communicationEventId,
                      visible,
                    )
                : undefined,
              beforeHeader: attachedRuns.length ? (
                <>
                  {attachedRuns.map(run => (
                    <AgentWorkReceipt
                      key={`run:${run.id}`}
                      agentName={agentName}
                      run={run}
                      paused={run.id === pausedRunId}
                      entries={activityByRun.get(run.id) ?? []}
                      projectId={projectId}
                      projectRoot={projectRoot}
                      onOpenFile={onOpenFile}
                      focusId={focusId}
                      active={run.id === activeExecutionId}
                      inline
                    />
                  ))}
                </>
              ) : undefined,
              source: fromSourceChat ? (
                <CommunicationSourceLink
                  message={message}
                  outgoing={outgoingTeamMessage}
                  onOpen={onOpenMessageSource!}
                />
              ) : undefined,
              body: (
                <ChatMessageBody
                  text={visibleText}
                  collaborationRecipients={message.communicationIntent === "collaboration" ? message.collaborationRecipients ?? [] : undefined}
                  agentMentions={message.agentMentions}
                  citations={message.citations}
                  collapseLongMessage={receivedInput}
                  compactMarkdown
                  agentIdForHandle={agentIdForHandle}
                  agentMentionForHandle={handle =>
                    authoredAgentMentionForHandle(
                      handle,
                      message.agentMentions,
                    )
                  }
                  operatorHandle={operatorProfile?.handle}
                  onOpenAgent={onOpenAgent}
                  previewScope={linkPreviewScopeForMessage(
                    message,
                    previewScope,
                  )}
                  projectId={projectId ?? previewScope?.projectId}
                  fileScope={fileOwnerForMessage(message, fileOwnerAgentId)}
                />
              ),
              afterBody: (
                <>
                  {message.document ? (
                    <CommunicationDocumentCard document={message.document} projectId={projectId} fileScope={fileOwnerForMessage(message, fileOwnerAgentId)} />
                  ) : null}
                </>
              ),
              attachments: message.attachments,
              belowBody: message.role === "user" ? <LiveAgentProgress receipts={message.deliveryReceipts} onOpenAgent={onOpenAgent} /> : undefined,
              attachmentDensity: "compact",
              status:
                (message.role === "user" || message.communicationIntent === "collaboration") && message.deliveryReceipts?.length ? (
                  <MessageDeliveryStatus
                    projectId={projectId ?? previewScope?.projectId}
                    receipts={message.deliveryReceipts}
                    recipientName={agentId =>
                      agentNameForId?.(agentId) ?? agentName
                    }
                    onOpenAgent={onOpenAgent}
                    compactSuccess={message.communicationIntent === "user_dm"}
                    compactSuccessTooltip={false}
                  />
                ) : undefined,
              actions: (
                <>
                  <CopyMessageButton text={message.communicationIntent === "collaboration" ? message.text : visibleAgentMessageText(message)} />
                  <MessageRequestAction
                    projectId={projectId}
                    conversationId={message.conversationId}
                    requests={message.coordinationRequests}
                    recipients={message.collaborationRecipients}
                    receipts={message.deliveryReceipts}
                    agentTitle={agentId => agentId ? agentNameForId?.(agentId) ?? "Deleted Agent" : "You"}
                  />
                  {message.role === "assistant" || message.authorAgentId ? (
                    <ReadAloudControls text={readAloudText} />
                  ) : null}
                </>
              ),
              }}
            />
          </Fragment>
        );
      })}
    </ChatSurface>
  );
}

/**
 * Agent detail keeps this pane mounted while another local tab is visible.
 * Most tab changes do not alter any chat inputs, so avoid reparsing every
 * Markdown message merely to hide or reveal the preserved pane.
 */
export const ChatPane = memo(ChatPaneComponent);
