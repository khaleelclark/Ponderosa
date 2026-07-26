import AddIcon from "@mui/icons-material/Add";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import TagIcon from "@mui/icons-material/Tag";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import {
  Box,
  Button,
  ButtonBase,
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
} from "@ponderosa/core";
import {
  memo,
  type Dispatch,
  type SetStateAction,
} from "react";
import { agentMentionHandle } from "../mentions";
import { mobileOperationalStatus } from "../mobileChat";
import { transcriptFileName } from "../chatTranscript";
import { CopyMessageButton } from "./CopyMessageButton";
import { ResponseFileActivity } from "./activity/ResponseFileActivity";
import {
  ChatMessageBody,
  CommunicationDocumentCard,
  stripDocumentPrefixText,
} from "./chat/ChatMessages";
import { ProjectRelationshipLink } from "./HeaderRelationshipLinks";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { DecisionCard } from "./decisions/DecisionCard";
import { ChatMessageFrame } from "./chat/ChatMessageFrame";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import type { MainTimelineEntry } from "./ConversationView.helpers";

function ConversationMessageComponent({
  message,
  conversation,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
  onEdit,
  onMentionAgent,
  onVisible,
  projectId,
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
  onEdit?: (message: ConversationMessageDto) => void;
  onMentionAgent?(agentId: string): void;
  onVisible?(): void;
  projectId: string;
  activeRunId?: string;
  operatorProfile?: OperatorProfileDto;
}): JSX.Element {
  const fromManager = !message.authorAgentId;
  // Routing prefixes are presentation chips, but remain in canonical/copyable
  // text. Do not hide a prefix merely because the scope is also structured.
  const routedText = message.text;
  const visibleText = stripDocumentPrefixText(
    routedText,
    Boolean(message.document),
  );
  const senderName = fromManager
    ? (operatorProfile?.displayName ?? "You")
    : agentTitle(message.authorAgentId);

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
        onVisible,
        body: (
          <ChatMessageBody
            text={visibleText}
            compactMarkdown
            citations={message.citations}
            agentIdForHandle={agentIdForHandle}
            agentMentionForHandle={handle => {
              const binding = message.agentMentions?.find(
                item =>
                  item.handle.toLocaleLowerCase() ===
                  handle.toLocaleLowerCase(),
              );
              return binding
                ? {
                    agentId: binding.agentId,
                    label: agentMentionHandle(agentTitle(binding.agentId)),
                  }
                : undefined;
            }}
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
            {message.correctionOfMessageId ? (
              <Chip size="small" label="Correction" sx={{ mt: 0.75 }} />
            ) : null}
            {message.correctedByMessageId ? (
              <Chip
                size="small"
                variant="outlined"
                label="Corrected below"
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
            />
          ) : undefined,
        actions:
          conversation === "main" ? (
            <>
              <CopyMessageButton text={visibleText} />
              {message.authorAgentId && onMentionAgent ? (
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
              {onEdit ? (
                <Tooltip title="Edit Message">
                  <IconButton
                    size="small"
                    aria-label="Edit message"
                    onClick={() => onEdit(message)}
                  >
                    <EditOutlinedIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              ) : null}
            </>
          ) : undefined,
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
  activeView,
  agentWorkOpen,
  conversation,
  projectLabel,
  transcriptMarkdown,
  transcriptTitle,
  onOpenProject,
  setAgentWorkOpen,
  setRenameValue,
  setRenameOpen,
  onNewAgent,
  setImportOpen,
  setDeleteOpen,
  setActiveView,
}: {
  activeView: "main" | "collaboration" | "agents";
  agentWorkOpen: boolean;
  conversation: ConversationDto;
  projectLabel?: string;
  transcriptMarkdown: string;
  transcriptTitle: string;
  onOpenProject(): void;
  setAgentWorkOpen: Dispatch<SetStateAction<boolean>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setRenameOpen: Dispatch<SetStateAction<boolean>>;
  onNewAgent(master: ConversationDto, managerAgentId?: string): void;
  setImportOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteOpen: Dispatch<SetStateAction<boolean>>;
  setActiveView: Dispatch<
    SetStateAction<"main" | "collaboration" | "agents">
  >;
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
          <ChatOverflowMenu
            label={`${activeView === "collaboration" ? "Team Chat" : "Chat"} settings and actions`}
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            actions={[
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
                label: "Create Agent",
                icon: <AddIcon fontSize="small" />,
                onSelect: () => onNewAgent(conversation),
              },
              {
                label: "Import Agent or Organization",
                icon: <FileUploadOutlinedIcon fontSize="small" />,
                onSelect: () => setImportOpen(true),
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
        label: "Chat views",
        value: agentWorkOpen ? false : activeView,
        onChange: next => {
          setAgentWorkOpen(false);
          setActiveView(next);
        },
        items: [
          { value: "main", label: "Chat" },
          { value: "collaboration", label: "Team Chat" },
          {
            value: "agents",
            label: "Agents",
            icon: <SmartToyOutlinedIcon fontSize="small" />,
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
  healthByAgentId,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
  mentionAgent,
  markCommunicationVisible,
  editConversationMessage,
}: {
  mainTimeline: MainTimelineEntry[];
  operatorProfile?: OperatorProfileDto;
  projectId: string;
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
  markCommunicationVisible(communicationEventId: string | undefined): void;
  editConversationMessage(selected: ConversationMessageDto): void;
}): JSX.Element {
  return (
    <Stack spacing={0} sx={{ mb: 2 }}>
      {mainTimeline.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No messages yet. Send a request to start your first agent —
          its completed answer returns here.
        </Typography>
      ) : null}
      {mainTimeline.map(entry => {
        if (entry.kind === "decision") return <Box key={entry.id} sx={{ py: 1 }}>
          <DecisionCard decision={entry.event.decision} title={entry.event.decision.question} context={entry.event.decision.context} />
        </Box>;
        if (entry.kind === "decision-response") return <ChatMessageFrame
          key={entry.id}
          message={{
            id: entry.id,
            author: { kind: "operator", profile: operatorProfile },
            createdAt: entry.at,
            ariaLabel: `You chose ${entry.choice}`,
            body: <Typography variant="body2">You chose {entry.choice}.</Typography>,
          }}
        />;
        const message = entry.message;
        return <ConversationMessage
          key={entry.id}
          message={message}
          conversation="main"
          projectId={projectId}
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
          onVisible={() => markCommunicationVisible(message.communicationEventId)}
          onEdit={
            message.role === "user" &&
            !message.authorAgentId &&
            !message.correctedByMessageId &&
            !message.correctionOfMessageId
              ? editConversationMessage
              : undefined
          }
        />;
      })}
    </Stack>
  );
}

interface OperationalEventGroup {
  id: string;
  representative: TeamOperationalEventDto;
  events: TeamOperationalEventDto[];
}

function CollaborationTimeline({
  operationalEventGroups,
  expandedOperationalEventGroups,
  setExpandedOperationalEventGroups,
  operationalEvents,
  collaborationMessages,
  onOpenAgentWork,
  projectId,
  healthByAgentId,
  operatorProfile,
  agentTitle,
  agentIdForHandle,
  onOpenAgent,
  onOpenReview,
  onOpenFileActivity,
}: {
  operationalEventGroups: OperationalEventGroup[];
  expandedOperationalEventGroups: Set<string>;
  setExpandedOperationalEventGroups: Dispatch<SetStateAction<Set<string>>>;
  operationalEvents: TeamOperationalEventDto[];
  collaborationMessages: ConversationMessageDto[];
  onOpenAgentWork(focusId?: string): void;
  projectId: string;
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
  return (
    <Stack spacing={0} sx={{ mb: 2 }}>
      {operationalEventGroups.length ? (
        <Stack spacing={0.5} aria-label="Team operational activity">
          {operationalEventGroups.map(group => {
            const event = group.representative;
            const content = (
              <>
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    event.kind === "run"
                      ? "Agent"
                      : event.kind === "join"
                        ? "Waiting"
                        : event.kind === "request"
                          ? "Work"
                          : event.kind === "trigger"
                            ? "Trigger"
                            : event.kind === "decision"
                              ? "Decision"
                              : event.kind === "organization"
                                ? "Team"
                                : "Ready"
                  }
                />
                <Typography
                  variant="body2"
                  sx={{
                    display: { xs: "none", sm: "block" },
                    flex: 1,
                  }}
                >
                  {event.text}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    display: { xs: "block", sm: "none" },
                    flex: 1,
                  }}
                >
                  {mobileOperationalStatus(event.state)}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: { xs: "none", sm: "block" } }}
                >
                  {new Date(event.updatedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Typography>
              </>
            );
            const sx = {
              display: "flex",
              width: "100%",
              gap: 1,
              alignItems: "center",
              px: 1.25,
              py: 0.75,
              borderRadius: 1.5,
              bgcolor: "action.hover",
              textAlign: "left",
            } as const;
            const row = event.kind === "organization" ? (
              <Box key={event.id} sx={sx}>
                {content}
              </Box>
            ) : (
              <ButtonBase
                key={event.id}
                onClick={() => onOpenAgentWork(event.id)}
                aria-label={`${event.text}. Open Work details`}
                sx={sx}
              >
                {content}
              </ButtonBase>
            );
            if (group.events.length === 1) return row;
            const expanded = expandedOperationalEventGroups.has(group.id);
            return <Stack key={group.id} spacing={0.5}>
              <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>{row}</Box>
                <Button
                  size="small"
                  aria-expanded={expanded}
                  onClick={() => setExpandedOperationalEventGroups(current => {
                    const next = new Set(current);
                    if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                    return next;
                  })}
                >{expanded ? "Hide duplicates" : `×${group.events.length}`}</Button>
              </Box>
              {expanded ? <Stack spacing={0.5} sx={{ pl: 1.5 }} aria-label={`${group.events.length} duplicate operational events`}>
                {group.events.map(raw => <ButtonBase
                  key={raw.id}
                  onClick={() => onOpenAgentWork(raw.id)}
                  aria-label={`${raw.text}. Open Work details`}
                  sx={sx}
                >
                  <Typography variant="body2" sx={{ flex: 1, textAlign: "left" }}>{raw.text}</Typography>
                  <Typography variant="caption" color="text.secondary">{new Date(raw.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Typography>
                </ButtonBase>)}
              </Stack> : null}
            </Stack>;
          })}
        </Stack>
      ) : null}
      {collaborationMessages.length + operationalEvents.length ===
      0 ? (
        <Typography variant="body2" color="text.secondary">
          No agent-to-agent messages yet.
        </Typography>
      ) : null}
      {collaborationMessages.map(message => (
        <ConversationMessage
          key={message.id}
          message={message}
          conversation="collaboration"
          projectId={projectId}
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
      ))}
    </Stack>
  );
}

export {
  CollaborationTimeline,
  ConversationHeader,
  MainConversationTimeline,
};
