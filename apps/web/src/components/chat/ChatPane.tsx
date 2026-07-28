import TagIcon from "@mui/icons-material/Tag";
import { ButtonBase, IconButton, Tooltip } from "@mui/material";
import type {
  AgentActivityDto,
  AgentRunDto,
  MessageDto,
  OperatorProfileDto,
  ResponseFileActivityDto,
  RunOutputDto,
} from "@ponderosa/core";
import { Fragment, memo, useMemo } from "react";
import { agentMentionHandle } from "../../mentions";
import { CopyMessageButton } from "../CopyMessageButton";
import { MessageDeliveryStatus } from "../MessageDeliveryStatus";
import { buildActivityStream } from "../activity/activityStream";
import type { ActivityStreamEntry } from "../activity/activityStream";
import { AgentWorkReceipt } from "./AgentWorkReceipt";
import { ChatMessageFrame } from "./ChatMessageFrame";
import { ChatSurface } from "./ChatSurface";
import {
  ChatMessageBody,
  CommunicationDocumentCard,
  chatMessageLayoutKey,
  individualChatSenderLabel,
  linkPreviewScopeForMessage,
  stripDocumentPrefixText,
} from "./ChatMessages";
import type { LinkPreviewScope } from "./ChatMessages";
import { projectAgentChat } from "./agentChatProjection";

function CommunicationSourceLink({
  message,
  outgoing,
  onOpen,
}: {
  message: MessageDto;
  outgoing: boolean;
  onOpen(message: MessageDto): void;
}): JSX.Element {
  const projectBroadcast = message.communicationIntent === "broadcast";
  const sourceLabel = projectBroadcast
    ? "to Project Chat"
    : outgoing
      ? "to Team Chat"
      : "via Team Chat";
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
  if (message.communicationIntent !== "broadcast") return text;
  const withoutRoutingPrefix = text.replace(
    /^\s*#broadcast(?:\s+|$)/iu,
    "",
  );
  return withoutRoutingPrefix.trim() ? withoutRoutingPrefix : text;
}

function ChatPaneComponent({
  messages,
  agentName = "Agent",
  agentNameForId,
  agentIdForHandle,
  onOpenAgent,
  onOpenMessageSource,
  onMentionAgent,
  onScrollPositionChange,
  previewScope,
  scrollStorageKey,
  operatorProfile,
  projectId,
  activity = [],
  runOutput = [],
  runs = [],
  activeExecutionId,
  projectRoot,
  onOpenFile,
  onOpenFileInNewTab,
  focusId,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: {
  messages: MessageDto[];
  agentName?: string;
  agentNameForId?(agentId: string): string | undefined;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenMessageSource?(message: MessageDto): void;
  onMentionAgent?(): void;
  onScrollPositionChange?(element: HTMLElement, nearBottom: boolean): void;
  previewScope?: LinkPreviewScope;
  scrollStorageKey?: string;
  operatorProfile?: OperatorProfileDto;
  projectId?: string;
  activity?: AgentActivityDto[];
  runOutput?: RunOutputDto[];
  runs?: AgentRunDto[];
  activeExecutionId?: string;
  projectRoot?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  focusId?: string;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
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
      const anchor = response ?? request;
      if (!anchor) {
        standalone.push(run);
        continue;
      }
      const placedRuns = afterMessage.get(anchor.id);
      if (placedRuns) placedRuns.push(run);
      else afterMessage.set(anchor.id, [run]);
    }
    return { afterMessage, standalone };
  }, [agentChat.runs, chatMessages, messageByCommunicationId]);
  const timeline = useMemo(
    () =>
      [
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
    [chatMessages, runPlacement.standalone, unscopedActivity],
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
      empty="Send a message to this agent to start the conversation."
    >
      {timeline.map(item => {
        if (item.kind === "run") {
          const contextMessage = item.run.communicationEventId
            ? messageByCommunicationId.get(item.run.communicationEventId)
            : undefined;
          return (
            <AgentWorkReceipt
              key={item.id}
              agentName={agentName}
              run={item.run}
              entries={activityByRun.get(item.run.id) ?? []}
              projectId={projectId}
              projectRoot={projectRoot}
              onOpenFile={onOpenFile}
              onOpenFileInNewTab={onOpenFileInNewTab}
              focusId={focusId}
              active={item.run.id === activeExecutionId}
              contextText={
                contextMessage
                  ? visibleAgentMessageText(contextMessage)
                  : undefined
              }
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
              onOpenFileInNewTab={onOpenFileInNewTab}
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
                  citations={message.citations}
                  collapseLongMessage={receivedInput}
                  compactMarkdown
                  agentIdForHandle={agentIdForHandle}
                  agentMentionForHandle={handle => {
                    const binding = message.agentMentions?.find(
                      item =>
                        item.handle.toLocaleLowerCase() ===
                        handle.toLocaleLowerCase(),
                    );
                    const title = binding
                      ? agentNameForId?.(binding.agentId)
                      : undefined;
                    return binding && title
                      ? {
                          agentId: binding.agentId,
                          label: agentMentionHandle(title),
                        }
                      : undefined;
                  }}
                  operatorHandle={operatorProfile?.handle}
                  onOpenAgent={onOpenAgent}
                  previewScope={linkPreviewScopeForMessage(
                    message,
                    previewScope,
                  )}
                  projectId={projectId ?? previewScope?.projectId}
                />
              ),
              afterBody: (
                <>
                  {message.document ? (
                    <CommunicationDocumentCard document={message.document} />
                  ) : null}
                </>
              ),
              attachments: message.attachments,
              attachmentDensity: "compact",
              status:
                message.role === "user" && message.deliveryReceipts?.length ? (
                  <MessageDeliveryStatus
                    projectId={projectId ?? previewScope?.projectId}
                    receipts={message.deliveryReceipts}
                    recipientName={agentId =>
                      agentNameForId?.(agentId) ?? agentName
                    }
                    onOpenAgent={onOpenAgent}
                  />
                ) : undefined,
              actions: (
                <>
                  <CopyMessageButton text={message.text} />
                  {message.authorAgentId === message.agentId &&
                  onMentionAgent ? (
                    <Tooltip title={`Mention ${senderLabel}`}>
                      <IconButton
                        size="small"
                        aria-label={`Mention ${senderLabel}`}
                        onClick={onMentionAgent}
                      >
                        <TagIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </>
              ),
              }}
            />
            {attachedRuns.map(run => {
              const contextMessage = run.communicationEventId
                ? messageByCommunicationId.get(run.communicationEventId)
                : undefined;
              return (
                <AgentWorkReceipt
                  key={`run:${run.id}`}
                  agentName={agentName}
                  run={run}
                  entries={activityByRun.get(run.id) ?? []}
                  projectId={projectId}
                  projectRoot={projectRoot}
                  onOpenFile={onOpenFile}
                  onOpenFileInNewTab={onOpenFileInNewTab}
                  focusId={focusId}
                  active={run.id === activeExecutionId}
                  contextText={
                    contextMessage
                      ? visibleAgentMessageText(contextMessage)
                      : undefined
                  }
                />
              );
            })}
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
