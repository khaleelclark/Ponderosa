import AddIcon from "@mui/icons-material/Add";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import TagIcon from "@mui/icons-material/Tag";
import LanguageIcon from "@mui/icons-material/Language";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import {
  Box,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AgentHealthDto,
  ConversationDto,
  ConversationMessageDto,
  OperatorProfileDto,
  ResponseFileActivityDto,
  TeamOperationalEventDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import {
  memo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ConversationDetailView } from "../routing";
import { transcriptFileName } from "../chatTranscript";
import { CopyMessageButton } from "./CopyMessageButton";
import { ResponseFileActivity } from "./activity/ResponseFileActivity";
import {
  ChatMessageBody,
  CommunicationDocumentCard,
  authoredAgentMentionForHandle,
  communicationVisibleText,
  resolveMessageMentionText,
  showBroadcastBadge,
  stripDocumentPrefixText,
} from "./chat/ChatMessages";
import { ProjectRelationshipLink } from "./HeaderRelationshipLinks";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { MessageRequestAction } from "./MessageRequestAction";
import { DecisionCard } from "./decisions/DecisionCard";
import { decisionResponseSummary } from "./decisions/decisionResponse";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { NotificationAcknowledgementBoundary } from "./NotificationAcknowledgementBoundary";
import { useNotificationAcknowledgement } from "../hooks/useNotificationAcknowledgement";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import {
  AUTO_ALLOWED_DECISION_OPTION_ID,
  type MainTimelineEntry,
} from "./ConversationView.helpers";
import {
  coalesceTeamOperationalEvents,
  routineTeamLifecycleEvent,
  type PresentedTeamOperationalEvent,
} from "./teamChatPresentation";
import { ReadAloudControls } from "./speech/ReadAloudControls";

function ConversationMessageComponent({
  message,
  conversation,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
  onMentionAgent,
  onVisible,
  projectId,
  projectRoot,
  activeRunId,
  operatorProfile,
}: {
  message: ConversationMessageDto;
  conversation: "main" | "collaboration";
  agentTitle(agentId: string | undefined): string;
  agentIdForHandle(handle: string): string | undefined;
  onOpenAgent(
    agentId: string,
    view?: "technical",
    technicalFocusId?: string,
  ): void;
  onOpenReview?(agentId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onMentionAgent?(agentId: string): void;
  onVisible?(visible: boolean): void;
  projectId: string;
  projectRoot?: string;
  activeRunId?: string;
  operatorProfile?: OperatorProfileDto;
}): JSX.Element {
  const fromManager = !message.authorAgentId;
  const routedText = message.text;
  const copyableText = stripDocumentPrefixText(
    routedText,
    Boolean(message.document),
  );
  const visibleText = communicationVisibleText({
    text: copyableText,
    intent: message.communicationIntent,
    fromAgent: Boolean(message.authorAgentId),
    agentMentions: message.agentMentions,
  });
  const senderName = fromManager
    ? (operatorProfile?.displayName ?? "You")
    : agentTitle(message.authorAgentId);
  const resolvedCopyText = visibleText;

  return (
    <ChatMessageFrame
      message={{
        id: `master-message-${message.id}`,
        author: fromManager
          ? message.role === "user"
            ? { kind: "operator", profile: operatorProfile }
            : { kind: "notice" }
          : {
              kind: "agent",
              name: senderName,
              onOpen: () => onOpenAgent(message.authorAgentId!),
            },
        createdAt: message.createdAt,
        source:
          showBroadcastBadge(
            message.communicationIntent,
            message.communicationEventId,
          ) ? (
            <Chip size="small" variant="outlined" label="Broadcast" />
          ) : undefined,
        onVisible,
        body: (
          <ChatMessageBody
            text={visibleText}
            compactMarkdown
            preserveWhitespace={message.role === "user"}
            citations={message.citations}
            agentIdForHandle={agentIdForHandle}
            agentMentionForHandle={handle =>
              authoredAgentMentionForHandle(handle, message.agentMentions)
            }
            operatorHandle={operatorProfile?.handle}
            onOpenAgent={onOpenAgent}
            projectId={projectId}
            previewScope={
              message.authorAgentId &&
              message.executionId &&
              activeRunId === message.executionId
                ? {
                    projectId,
                    agentId: message.authorAgentId,
                    runId: message.executionId,
                    conversationId: message.conversationId,
                  }
                : undefined
            }
          />
        ),
        afterBody: (
          <>
            {message.editedAt ? (
              <Chip
                size="small"
                variant="outlined"
                label="Edited"
                sx={{ mt: 0.75 }}
              />
            ) : null}
            {message.document ? (
              <CommunicationDocumentCard document={message.document} />
            ) : null}
            {message.fileActivity?.length ? (
              <ResponseFileActivity
                files={message.fileActivity}
                projectId={projectId}
                projectRoot={projectRoot}
                onOpenFile={
                  message.authorAgentId && onOpenFileActivity
                    ? file => onOpenFileActivity(message.authorAgentId!, file)
                    : undefined
                }
                onViewAll={
                  message.authorAgentId && onOpenReview
                    ? () => onOpenReview(message.authorAgentId!)
                    : undefined
                }
              />
            ) : null}
          </>
        ),
        attachments: message.attachments,
        status:
          message.role === "user" && message.deliveryReceipts?.length ? (
            <MessageDeliveryStatus
              projectId={projectId}
              receipts={message.deliveryReceipts}
              recipientName={agentId => agentTitle(agentId)}
              onOpenAgent={onOpenAgent}
              compactSuccess={message.communicationIntent === "user_dm"}
            />
          ) : undefined,
        actions: (
          <>
            <CopyMessageButton text={resolvedCopyText} />
            {conversation === "collaboration" ? <MessageRequestAction
              projectId={projectId}
              conversationId={message.conversationId}
              requests={message.coordinationRequests}
              agentTitle={agentTitle}
            /> : null}
            {message.authorAgentId ? (
              <ReadAloudControls
                text={resolveMessageMentionText(
                  visibleText,
                  message.agentMentions,
                )}
              />
            ) : null}
            {conversation === "main" && message.authorAgentId && onMentionAgent ? (
                <Tooltip title={`Mention ${senderName}`}>
                  <IconButton
                    size="small"
                    aria-label={`Mention ${senderName}`}
                    onClick={() => onMentionAgent(message.authorAgentId!)}
                  >
                    <TagIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
            ) : null}
          </>
        ),
      }}
    />
  );
}

/**
 * Local Chat tabs preserve their message panels. Stable screen-level callbacks
 * let unchanged messages skip Markdown parsing when only panel visibility
 * changes.
 */
const ConversationMessage = memo(ConversationMessageComponent);

function ConversationHeader({
  onChatSettings,
  activeView,
  agentWorkOpen,
  conversation,
  projectLabel,
  transcriptMarkdown,
  transcriptTitle,
  onOpenProject,
  onOpenProjectBrowser,
  setAgentWorkOpen,
  setRenameValue,
  setRenameOpen,
  setAddAgentsOpen,
  setDeleteOpen,
  setActiveView,
}: {
  activeView: "main" | "collaboration" | "files" | "agents" | "triggers";
  onChatSettings(): void;
  agentWorkOpen: boolean;
  conversation: ConversationDto;
  projectLabel?: string;
  transcriptMarkdown: string;
  transcriptTitle: string;
  onOpenProject(): void;
  onOpenProjectBrowser(): void;
  setAgentWorkOpen: Dispatch<SetStateAction<boolean>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setRenameOpen: Dispatch<SetStateAction<boolean>>;
  setAddAgentsOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteOpen: Dispatch<SetStateAction<boolean>>;
  setActiveView(view: ConversationDetailView): void;
}): JSX.Element {
  return (
    <TabbedWorkspaceFrame
      icon={<ChatBubbleOutlineIcon />}
      title={conversation.title}
      context={
        <ProjectRelationshipLink
          projectLabel={projectLabel}
          onOpenProject={onOpenProject}
        />
      }
      actions={
        <>
          <Tooltip title="Open Project Browser">
            <IconButton
              aria-label="Open Project Browser"
              onClick={onOpenProjectBrowser}
            >
              <LanguageIcon />
            </IconButton>
          </Tooltip>
          <ChatOverflowMenu
            label={`${activeView === "collaboration" ? "Team Chat" : "Chat"} settings and actions`}
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            actions={[
              { label: "Chat settings", onSelect: onChatSettings },
              {
                label: "Work",
                icon: <AccountTreeOutlinedIcon fontSize="small" />,
                onSelect: () => setAgentWorkOpen(true),
              },
              {
                label: "Rename",
                icon: <DriveFileRenameOutlineIcon fontSize="small" />,
                onSelect: () => {
                  setRenameValue(conversation.title);
                  setRenameOpen(true);
                },
              },
              {
                label: "Add Agents…",
                icon: <AddIcon fontSize="small" />,
                onSelect: () => setAddAgentsOpen(true),
              },
              {
                label: "Delete",
                icon: <DeleteOutlineIcon fontSize="small" />,
                destructive: true,
                onSelect: () => setDeleteOpen(true),
              },
            ]}
          />
        </>
      }
      tabs={{
        idPrefix: "chat-workspace",
        activeLabel: agentWorkOpen ? "Work" : undefined,
        label: "Chat views",
        value: agentWorkOpen ? false : activeView,
        onChange: next => {
          setAgentWorkOpen(false);
          setActiveView(next);
        },
        items: [
          {
            value: "main",
            label: "Chat",
            icon: <ChatBubbleOutlineIcon fontSize="small" />,
          },
          {
            value: "collaboration",
            label: "Team Chat",
            icon: <GroupsOutlinedIcon fontSize="small" />,
          },
          {
            value: "files",
            label: "Files & Results",
            icon: <Inventory2OutlinedIcon fontSize="small" />,
          },
          {
            value: "agents",
            label: "Agents",
            icon: <SmartToyOutlinedIcon fontSize="small" />,
          },
          {
            value: "triggers",
            label: "Automations",
            icon: <BoltOutlinedIcon fontSize="small" />,
          },
        ],
      }}
    />
  );
}

function MainConversationTimeline({
  mainTimeline,
  operatorProfile,
  projectId,
  projectRoot,
  healthByAgentId,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
  mentionAgent,
  markCommunicationVisible,
  notifications,
}: {
  mainTimeline: MainTimelineEntry[];
  operatorProfile?: OperatorProfileDto;
  projectId: string;
  projectRoot?: string;
  healthByAgentId: Map<string, AgentHealthDto>;
  agentTitle(agentId: string | undefined): string;
  agentIdForHandle(handle: string): string | undefined;
  onOpenAgent(
    agentId: string,
    view?: "technical",
    technicalFocusId?: string,
  ): void;
  onOpenReview?(agentId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  mentionAgent(agentId: string): void;
  markCommunicationVisible(
    communicationEventId: string | undefined,
    visible: boolean,
  ): void;
  notifications: WorkspaceNotificationDto[];
}): JSX.Element {
  const acknowledgeNotifications = useNotificationAcknowledgement();
  return (
    <Stack spacing={0} sx={{ mb: 2 }}>
      {mainTimeline.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No messages yet. Send a message or mention an Agent to start this Chat.
        </Typography>
      ) : null}
      {mainTimeline.map(entry => {
        if (entry.kind === "decision") {
          const notification = notifications.find((item) =>
            item.decision?.id === entry.event.decision.id && (item.status ?? "open") === "open");
          const card = <Box key={entry.id} sx={{ py: 1 }}>
          <DecisionCard decision={entry.event.decision} title={entry.event.decision.question} context={entry.event.decision.context} />
          </Box>;
          return notification ? <NotificationAcknowledgementBoundary
            key={entry.id}
            notificationId={notification.id}
            acknowledged={Boolean(notification.acknowledgedAt)}
            onAcknowledge={acknowledgeNotifications}
          >{card}</NotificationAcknowledgementBoundary> : card;
        }
        if (entry.kind === "decision-response") {
          const automatic =
            entry.event.decision.response?.optionId ===
            AUTO_ALLOWED_DECISION_OPTION_ID;
          return <ChatMessageFrame
          key={entry.id}
          message={{
            id: entry.id,
            author: automatic
              ? { kind: "notice" }
              : { kind: "operator", profile: operatorProfile },
            createdAt: entry.at,
            ariaLabel: automatic ? entry.choice : decisionResponseSummary(entry.event.decision, entry.choice),
            body: <Typography variant="body2">
              {automatic ? entry.choice : decisionResponseSummary(entry.event.decision, entry.choice)}
            </Typography>,
          }}
          />;
        }
        const message = entry.message;
        return <ConversationMessage
          key={entry.id}
          message={message}
          conversation="main"
          projectId={projectId}
          projectRoot={projectRoot}
          activeRunId={
            message.authorAgentId
              ? healthByAgentId.get(message.authorAgentId)
                  ?.runtimeActivity?.executionId
              : undefined
          }
          operatorProfile={operatorProfile}
          agentTitle={agentTitle}
          agentIdForHandle={agentIdForHandle}
          onOpenAgent={onOpenAgent}
          onOpenReview={onOpenReview}
          onOpenFileActivity={onOpenFileActivity}
          onMentionAgent={mentionAgent}
          onVisible={(visible) =>
            markCommunicationVisible(message.communicationEventId, visible)}
        />;
      })}
    </Stack>
  );
}

function CollaborationTimeline({
  operationalEvents,
  collaborationMessages,
  projectId,
  projectRoot,
  healthByAgentId,
  operatorProfile,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
}: {
  operationalEvents: TeamOperationalEventDto[];
  collaborationMessages: ConversationMessageDto[];
  projectId: string;
  projectRoot?: string;
  healthByAgentId: Map<string, AgentHealthDto>;
  operatorProfile?: OperatorProfileDto;
  agentTitle(agentId: string | undefined): string;
  agentIdForHandle(handle: string): string | undefined;
  onOpenAgent(
    agentId: string,
    view?: "technical",
    technicalFocusId?: string,
  ): void;
  onOpenReview?(agentId: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
}): JSX.Element {
  const loadedCommunicationIds = new Set(
    collaborationMessages.flatMap(message =>
      message.communicationEventId ? [message.communicationEventId] : [],
    ),
  );
  const linkedRequestEventIds = new Set<string>();
  for (const event of operationalEvents) {
    const communicationEventId =
      event.kind === "request"
        ? event.request?.communicationEventId
        : undefined;
    if (!communicationEventId || !event.request) continue;
    if (loadedCommunicationIds.has(communicationEventId)) {
      linkedRequestEventIds.add(event.id);
    }
  }
  const visibleOperations = coalesceTeamOperationalEvents(
    operationalEvents.filter(
      event =>
        !linkedRequestEventIds.has(event.id) &&
        (event.attentionRequired || routineTeamLifecycleEvent(event)),
    ),
  );
  const timeline = [
    ...collaborationMessages.map(message => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      at: message.createdAt,
      message,
    })),
    ...visibleOperations
      .map(event => ({
        kind: "operation" as const,
        id: `operation:${event.id}`,
        at: event.updatedAt,
        event,
      })),
  ].sort(
    (left, right) =>
      left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
  type TimelineEntry = typeof timeline[number];
  type RoutineTimelineEntry = {
    kind: "routine";
    id: string;
    at: string;
    lastAt: string;
    events: PresentedTeamOperationalEvent[];
  };
  const groupedTimeline: Array<TimelineEntry | RoutineTimelineEntry> = [];
  for (const entry of timeline) {
    if (entry.kind !== "operation" || !routineTeamLifecycleEvent(entry.event)) {
      groupedTimeline.push(entry);
      continue;
    }
    const previous = groupedTimeline.at(-1);
    if (previous?.kind === "routine") {
      previous.events.push(entry.event);
      previous.lastAt = entry.at;
      continue;
    }
    groupedTimeline.push({
      kind: "routine",
      id: `routine:${entry.id}`,
      at: entry.at,
      lastAt: entry.at,
      events: [entry.event],
    });
  }

  return (
    <Stack spacing={0} sx={{ mb: 2 }}>
      {timeline.length === 0 ? (
        <Box sx={{ py: 5, textAlign: "center" }}>
          <Typography variant="body2" color="text.secondary">
            No Agent-to-Agent messages yet.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Mentions and replies will appear here automatically.
          </Typography>
        </Box>
      ) : null}
      {groupedTimeline.map(entry => {
        if (entry.kind === "routine") {
          const underlyingEvents = entry.events.flatMap(
            event => event.relatedLifecycleEvents,
          );
          return (
            <Box
              component="details"
              key={entry.id}
              sx={{ borderTop: 1, borderColor: "divider", color: "text.secondary" }}
            >
              <Box
                component="summary"
                sx={{
                  alignItems: "center",
                  cursor: "pointer",
                  display: "flex",
                  gap: 1.25,
                  listStyle: "none",
                  py: 1,
                  "&::-webkit-details-marker": { display: "none" },
                }}
              >
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  Operational updates
                </Typography>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                  {underlyingEvents.length} queued or stopped transition{underlyingEvents.length === 1 ? "" : "s"}
                </Typography>
                <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
                  {new Date(entry.lastAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Typography>
              </Box>
              <Stack spacing={0.75} sx={{ pb: 1, pl: { xs: 2, sm: 3 } }}>
                {underlyingEvents.map((event, index) => (
                  <Stack key={`${event.id}:${index}`} direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
                    <Typography variant="caption" sx={{ minWidth: 72 }}>{event.state === "outcome_unknown" ? "Result unconfirmed" : event.state.replaceAll("_", " ")}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{event.text}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(event.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          );
        }
        if (entry.kind === "operation") {
          const event = entry.event;
          return (
            <Box
              key={entry.id}
              sx={{
                display: "flex",
                width: "100%",
                gap: 1.25,
                alignItems: "center",
                py: 1,
                borderTop: 1,
                borderColor: "divider",
                textAlign: "left",
              }}
            >
              <Tooltip
                title={event.relatedLifecycleCount > 1
                  ? `${event.relatedLifecycleCount} related lifecycle updates are shown once.`
                  : ""}
              >
                <Typography
                  variant="caption"
                  sx={{
                    color:
                      event.kind === "decision"
                        ? "warning.light"
                        : "error.light",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {event.kind === "decision"
                    ? "Decision needed"
                    : "Coordination issue"}
                </Typography>
              </Tooltip>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                {event.text}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ whiteSpace: "nowrap" }}
              >
                {new Date(event.updatedAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </Typography>
            </Box>
          );
        }
        const message = entry.message;
        return (
          <Box key={entry.id}>
            <ConversationMessage
              message={message}
              conversation="collaboration"
              projectId={projectId}
              projectRoot={projectRoot}
              activeRunId={
                message.authorAgentId
                  ? healthByAgentId.get(message.authorAgentId)
                      ?.runtimeActivity?.executionId
                  : undefined
              }
              operatorProfile={operatorProfile}
              agentTitle={agentTitle}
              agentIdForHandle={agentIdForHandle}
              onOpenAgent={onOpenAgent}
              onOpenReview={onOpenReview}
              onOpenFileActivity={onOpenFileActivity}
            />
          </Box>
        );
      })}
    </Stack>
  );
}

export {
  CollaborationTimeline,
  ConversationHeader,
  MainConversationTimeline,
};
