import {attachmentsOutsideVisualizations} from "./chat/messageMarkdown";
import { OutgoingMessageRow } from "./chat/OutgoingMessage";
import {useTextReplyProjection,ReplyReadFeedback} from './chat/useTextReplyProjection';
import {useWorkspaceReadOnly} from "./WorkspaceReadOnlyContext";
import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import TagIcon from "@mui/icons-material/Tag";
import LanguageIcon from "@mui/icons-material/Language";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
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
  useCallback,
  useMemo,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ConversationDetailView } from "../routing";
import { transcriptFileName } from "../chatTranscript";
import { CopyMessageButton } from "./CopyMessageButton";
import { ResponseFileActivity } from "./activity/ResponseFileActivity";
import {
  ChatMessageBody,
  fileOwnerForMessage,
  CommunicationDocumentCard,
  authoredAgentMentionForHandle,
  communicationVisibleText,
  resolveMessageMentionText,
  showBroadcastBadge,
  stripDocumentPrefixText,
} from "./chat/ChatMessages";
import { ProjectRelationshipLink } from "./HeaderRelationshipLinks";
import { ChatOverflowMenu, type ChatOverflowAction } from "./ChatOverflowMenu";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { MessageRequestAction } from "./MessageRequestAction";
import { DecisionCard } from "./decisions/DecisionCard";
import { DecisionResponseMessage } from "./decisions/DecisionResponseMessage";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { LiveAgentProgress } from "./chat/LiveAgentProgress";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import {
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
  provisional=false,
  replyFeedback,
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
  onOpenReview?(agentId: string, executionId?: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  onMentionAgent?(agentId: string): void;
  onVisible?(communicationEventId: string | undefined, visible: boolean): void;
  projectId: string;
  projectRoot?: string;
  activeRunId?: string;
  provisional?:boolean;
  replyFeedback?:JSX.Element;
  operatorProfile?: OperatorProfileDto;
}): JSX.Element {
  const reportVisibility = useCallback((visible: boolean) =>
    onVisible?.(message.communicationEventId, visible), [onVisible, message.communicationEventId]);
  // Receipt/status updates must not invalidate unchanged Markdown inputs.
  const authoredMention = useCallback((handle: string) =>
    authoredAgentMentionForHandle(handle, message.agentMentions), [message.agentMentions]);
  const fileScope = useMemo(() => fileOwnerForMessage(message),
    [message.authorAgentId, message.conversationId]);
  const previewScope = useMemo(() => message.authorAgentId && message.executionId && activeRunId === message.executionId
    ? { projectId, agentId: message.authorAgentId, runId: message.executionId, conversationId: message.conversationId }
    : undefined, [projectId, message.authorAgentId, message.executionId, message.conversationId, activeRunId]);
  const collaborationRecipients = useMemo(() => message.communicationIntent === "collaboration"
    ? message.collaborationRecipients ?? [] : undefined, [message.communicationIntent, message.collaborationRecipients]);
  const fromManager = !message.authorAgentId;
  const routedText = message.text;
  const copyableText = stripDocumentPrefixText(
    routedText,
    Boolean(message.document),
  );
  const visibleText = useMemo(() => communicationVisibleText({
    text: copyableText,
    intent: message.communicationIntent,
    fromAgent: Boolean(message.authorAgentId),
    agentMentions: message.agentMentions,
  }), [copyableText, message.communicationIntent, message.authorAgentId, message.agentMentions]);
  const readAloudText = useMemo(() => message.authorAgentId
    ? resolveMessageMentionText(visibleText, message.agentMentions) : "",
    [visibleText, message.authorAgentId, message.agentMentions]);
  const senderName = fromManager
    ? (operatorProfile?.displayName ?? "You")
    : agentTitle(message.authorAgentId);
  const resolvedCopyText = message.communicationIntent === "collaboration" ? message.text : visibleText;

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
        onVisible: !provisional&&onVisible ? reportVisibility : undefined,
        body: (
          <ChatMessageBody
                  artifactSource={message}
            text={visibleText}
            collaborationRecipients={collaborationRecipients}
            agentMentions={message.agentMentions}
            compactMarkdown
            citations={message.citations}
            agentIdForHandle={agentIdForHandle}
            agentMentionForHandle={authoredMention}
            operatorHandle={operatorProfile?.handle}
            onOpenAgent={onOpenAgent}
            projectId={projectId}
            fileScope={fileScope}
            previewScope={previewScope}
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
              <CommunicationDocumentCard document={message.document} projectId={projectId} fileScope={fileScope} />
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
                  message.authorAgentId && message.executionId && onOpenReview
                    ? () => onOpenReview(message.authorAgentId!, message.executionId)
                    : undefined
                }
                viewAllUnavailableReason={!message.executionId
                  ? "Response review is unavailable because this message has no recorded Run ID."
                  : undefined}
              />
            ) : null}
          </>
        ),
        attachments: attachmentsOutsideVisualizations({...message,text:visibleText,projectId,fromAgent:message.role==="assistant"||Boolean(message.authorAgentId)}),
        belowBody: <>{message.role === "user" ? <LiveAgentProgress receipts={message.deliveryReceipts} onOpenAgent={onOpenAgent} /> : null}{replyFeedback}</>,
        status:
          (message.role === "user" || message.communicationIntent === "collaboration") && message.deliveryReceipts?.length ? (
            <MessageDeliveryStatus
              projectId={projectId}
              receipts={message.deliveryReceipts}
              recipientName={agentId => agentTitle(agentId)}
              onOpenAgent={onOpenAgent}
              compactSuccess={message.communicationIntent === "user_dm"}
            />
          ) : undefined,
        actions: !provisional&& (
          <>
            <CopyMessageButton text={resolvedCopyText} />
            {conversation === "collaboration" ? <MessageRequestAction
              projectId={projectId}
              conversationId={message.conversationId}
              requests={message.coordinationRequests}
              recipients={message.collaborationRecipients}
              receipts={message.deliveryReceipts}
              agentTitle={agentTitle}
            /> : null}
            {message.authorAgentId ? (
              <ReadAloudControls
                text={readAloudText}
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
  titleControl,
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
  titleControl?: ReactNode;
  activeView: "main" | "collaboration" | "files" | "agents";
  onChatSettings(): void;
  agentWorkOpen: boolean;
  conversation: ConversationDto;
  projectLabel?: string;
  transcriptMarkdown: string | (() => string);
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
  const auditOnly=useWorkspaceReadOnly();
  const chatActions = useMemo<ChatOverflowAction[]>(()=>[
    { label: "Chat Settings", onSelect: onChatSettings },
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
  ],[onChatSettings,setAgentWorkOpen,setRenameValue,conversation.title,setRenameOpen,setAddAgentsOpen,setDeleteOpen]);
  const menuLabel = `${activeView === "collaboration" ? "Team Chat" : "Chat"} settings and actions`;
  const browserAction = useMemo(() => <Tooltip title="Open Browser">
    <IconButton aria-label="Open Browser" onClick={onOpenProjectBrowser}><LanguageIcon /></IconButton>
  </Tooltip>,[onOpenProjectBrowser]);
  const renderCollapsedMenu = useCallback((openUsage:(anchor:HTMLElement)=>void,fullTrigger?:ReactNode)=><Stack direction="row" spacing={0.5} sx={{alignItems:"center",flexWrap:"nowrap"}}>
    {fullTrigger}
    {fullTrigger && !auditOnly ? browserAction : null}
    {!auditOnly || !fullTrigger ? <ChatOverflowMenu
      label={menuLabel} transcriptMarkdown={transcriptMarkdown}
      transcriptFileName={transcriptFileName(transcriptTitle)} showExports={!auditOnly}
      actions={[
        ...(auditOnly ? [] : chatActions),
        ...(!fullTrigger ? [
          {label:"Provider Usage",icon:<DataUsageOutlinedIcon fontSize="small"/>,onSelect:openUsage},
          ...(!auditOnly ? [{label:"Browser",icon:<LanguageIcon fontSize="small"/>,onSelect:onOpenProjectBrowser}] : []),
        ] : []),
      ]}
    /> : null}
  </Stack>,[menuLabel,transcriptMarkdown,transcriptTitle,auditOnly,chatActions,onOpenProjectBrowser,browserAction]);
  return (
    <TabbedWorkspaceFrame
      collapsedIconTabs
      collapsedActions={<PrimaryHeaderActionsOutlet renderTrigger={renderCollapsedMenu}/>}
      compactMobile
      icon={<ChatBubbleOutlineIcon />}
      title={conversation.title}
      titleControl={titleControl}
      context={
        <ProjectRelationshipLink
          projectLabel={projectLabel}
          onOpenProject={onOpenProject}
        />
      }
      actions={auditOnly?null:
        <>
          {browserAction}
          <ChatOverflowMenu
            label={`${activeView === "collaboration" ? "Team Chat" : "Chat"} Settings And Actions`}
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            actions={chatActions}
          />
        </>
      }
      tabs={{
        idPrefix: "chat-workspace",
        activeLabel: agentWorkOpen ? "Work" : undefined,
        label: "Chat Views",
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
        ].filter(item=>!auditOnly||item.value!=="agents") as Array<{value:ConversationDetailView;label:string;icon:JSX.Element}>,
      }}
    />
  );
}

function MainConversationTimeline({
  mainTimeline,
  firstMountedIndex = 0,
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
  firstMountedIndex?: number;
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
  onOpenReview?(agentId: string, executionId?: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
  mentionAgent(agentId: string): void;
  markCommunicationVisible(
    communicationEventId: string | undefined,
    visible: boolean,
  ): void;
  notifications: WorkspaceNotificationDto[];
}): JSX.Element {
  const replySources=mainTimeline.flatMap(item=>item.kind==='message'?[item.message]:[]);
  const replyRows=useTextReplyProjection(replySources,projectId,JSON.stringify([projectId,'main',replySources[0]?.conversationId]));
  const visibleIds=new Set(mainTimeline.slice(firstMountedIndex).map(entry=>entry.id));
  const timeline=[...mainTimeline.flatMap(entry=>entry.kind!=='message'&&visibleIds.has(entry.id)?[entry]:[]),...replyRows.filter(row=>row.provisional||visibleIds.has(`message:${row.message.id}`)).map(row=>({kind:'message' as const,id:row.key,at:row.at,message:row.message,provisional:row.provisional,feedback:row.feedback}))].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  return (
    <Stack spacing={0} sx={{ mb: 2 }}>
      <OutgoingMessageRow empty={<Typography variant="body2" color="text.secondary">No messages yet · send a message or mention an Agent</Typography>}
        entries={timeline.map(entry => ({
        id: entry.id, createdAt: entry.at,
        ...(entry.kind === "message" ? {communicationEventId:entry.message.communicationEventId,creationIdempotencyKey:entry.message.creationIdempotencyKey,projectId} : {}),
        render: createdAt => {
        if (entry.kind === "decision") {
          const notification = notifications.find((item) =>
            item.decision?.id === entry.event.decision.id && (item.status ?? "open") === "open");
          const card = <Box key={entry.id} sx={{ py: 1 }}>
          <DecisionCard decision={entry.event.decision} title={entry.event.decision.question} context={entry.event.decision.context} />
          </Box>;
          return notification ? <Box key={entry.id} data-notification-id={notification.id}>{card}</Box> : card;
        }
        if (entry.kind === "decision-response") {
          return <DecisionResponseMessage key={entry.id} event={entry.event}
            operatorProfile={operatorProfile} onOpenAgent={onOpenAgent} />;
        }
        const message = entry.provisional||entry.message.replyStream||entry.message.createdAt===createdAt?entry.message:{...entry.message,createdAt};
        return <ConversationMessage
          key={entry.id}
          message={message}
          conversation="main"
          provisional={entry.provisional}
          replyFeedback={entry.feedback?.length?<ReplyReadFeedback entry={entry.feedback} agentTitle={agentTitle}/>:undefined}
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
          onVisible={markCommunicationVisible}
        />;
      }}))}/>
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
  onOpenReview?(agentId: string, executionId?: string): void;
  onOpenFileActivity?(agentId: string, file: ResponseFileActivityDto): void;
}): JSX.Element {
  const replyRows=useTextReplyProjection(collaborationMessages,projectId,JSON.stringify([projectId,'collaboration',collaborationMessages[0]?.conversationId]));
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
    ...replyRows.map(row => ({
      kind: "message" as const,id:row.key,at:row.at,message:row.message,provisional:row.provisional,feedback:row.feedback,
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
              provisional={entry.provisional}
            replyFeedback={entry.feedback?.length?<ReplyReadFeedback entry={entry.feedback} agentTitle={agentTitle}/>:undefined}
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
