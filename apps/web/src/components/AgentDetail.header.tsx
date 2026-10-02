import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { Button, Link, Stack, Typography } from "@mui/material";
import type { AgentDto, AgentHealthDto } from "@ponderosa/core";
import { copyText } from "../clipboard";
import {
  agentStatusLabel,
  agentStatusPresentation,
  type AgentStatus,
} from "../agents";
import { downloadMarkdownTranscript, transcriptFileName } from "../chatTranscript";
import { formatExecutionElapsed } from "../time";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import type { AgentTab } from "./AgentDetail.helpers";
import {
  AgentHeaderRelationships,
  type AgentHeaderChat,
} from "./HeaderRelationshipLinks";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import { useAgentRunClock } from "./useAgentRunClock";
import type { WorkspaceConnectionStatus } from "../hooks/useWorkspaceStream";
import { SemanticStatus, semanticAgentStatus } from "./SemanticStatus";

export const AGENT_DETAIL_TABS: Array<{
  value: AgentTab;
  label: string;
  icon: JSX.Element;
}> = [
  { value: "chat", label: "Chat", icon: <ChatBubbleOutlineIcon /> },
  { value: "subagents", label: "Subagents", icon: <AccountTreeOutlinedIcon /> },
  { value: "triggers", label: "Automations", icon: <BoltOutlinedIcon /> },
  {
    value: "artifacts",
    label: "Files & Results",
    icon: <Inventory2OutlinedIcon />,
  },
  { value: "settings", label: "Settings", icon: <SettingsOutlinedIcon /> },
];

function AgentRunState({
  status,
  statusLabelOverride,
  health,
  connectionStatus,
  phaseEvidenceFresh,
  startedAt,
  agentNameForId,
}: {
  status: AgentStatus;
  statusLabelOverride?: string;
  health?: AgentHealthDto;
  connectionStatus: WorkspaceConnectionStatus;
  phaseEvidenceFresh: boolean;
  startedAt?: string;
  agentNameForId(agentId: string): string | undefined;
}): JSX.Element {
  const now = useAgentRunClock(startedAt);
  const presentation = statusLabelOverride ? {
    label: statusLabelOverride,
    accessibleLabel: `Agent status: ${statusLabelOverride}`,
    detail: `Agent status: ${statusLabelOverride}`,
  } : agentStatusPresentation(health, {
    status,
    connectionStatus,
    phaseEvidenceFresh,
    agentNameForId,
  });
  const elapsed = startedAt ? formatExecutionElapsed(startedAt, now) : undefined;
  const runState = elapsed
    ? `${presentation.label} · ${elapsed}`
    : presentation.label;
  const connectionState = connectionStatus === "live"
    ? "Live"
    : connectionStatus === "stale"
      ? "Stale"
      : connectionStatus === "unavailable"
        ? "Unavailable"
        : connectionStatus === "connecting"
          ? "Connecting"
          : "Reconnecting";
  const details = statusLabelOverride ? "" : [
    "Current: " + presentation.detail,
    health?.latestRun ? "Latest Run: " + agentStatusLabel(health.latestRun.status) : undefined,
    health?.assignedWorkOutcome ? "Assigned work: " + agentStatusLabel(health.assignedWorkOutcome.status) : undefined,
    health?.attention ? "Needs attention: " + agentStatusLabel(health.attention.status) : undefined,
  ].filter(Boolean).join(" · ");
  const delayed = connectionStatus === "stale" || connectionStatus === "unavailable";
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap" alignItems="center" sx={{ minWidth: 0, flexShrink: 1 }}>
      <SemanticStatus
        status={semanticAgentStatus(status)}
        label={connectionStatus === "live" ? `${runState} · Live` : `${delayed ? "Last known: " : ""}${runState}`}
        detail={`${presentation.accessibleLabel}${elapsed ? `; ${elapsed}` : ""}; ${connectionState.toLocaleLowerCase()}. ${details}`}
      />
      {connectionStatus !== "live" && <SemanticStatus status={delayed ? "blocked" : "idle"}
        label={connectionStatus === "stale" ? "Updates delayed" : connectionStatus === "unavailable"
          ? "Updates unavailable" : `${connectionState} updates`}
        detail="Connection to live updates on this device. This does not stop the Agent's work." />}
    </Stack>
  );
}

interface AgentDetailHeaderProps {
  agent: AgentDto;
  projectLabel?: string;
  chats: AgentHeaderChat[];
  lineageAgent?: AgentDto;
  lineageAgentId?: string;
  lineageLabel: string;
  status: AgentStatus;
  statusLabelOverride?: string;
  health?: AgentHealthDto;
  connectionStatus: WorkspaceConnectionStatus;
  phaseEvidenceFresh: boolean;
  startedAt?: string;
  agentNameForId(agentId: string): string | undefined;
  running: boolean;
  stopping: boolean;
  tab: AgentTab;
  showSubagents: boolean;
  showAutomations: boolean;
  transcriptMarkdown: string;
  transcriptTitle: string;
  onOpenProject(): void;
  onOpenChat(conversationId: string): void;
  onOpenAgent(agentId: string): void;
  onStop(): void;
  onExportPackage(): void;
  onDuplicate?(): void;
  onNotice(message: string): void;
  onOpenTechnical(): void;
  onRename(): void;
  onCreateAgent(): void;
  onChangeReportingLine(): void;
  onDelete(): void;
  onTabChange(tab: AgentTab): void;
}

export function AgentDetailHeader({
  agent,
  projectLabel,
  chats,
  lineageAgent,
  lineageAgentId,
  lineageLabel,
  health,
  status,
  statusLabelOverride,
  connectionStatus,
  phaseEvidenceFresh,
  startedAt,
  agentNameForId,
  running,
  stopping,
  tab,
  showSubagents,
  showAutomations,
  transcriptMarkdown,
  transcriptTitle,
  onOpenProject,
  onOpenChat,
  onOpenAgent,
  onStop,
  onExportPackage,
  onDuplicate,
  onNotice,
  onOpenTechnical,
  onRename,
  onCreateAgent,
  onChangeReportingLine,
  onDelete,
  onTabChange,
}: AgentDetailHeaderProps): JSX.Element {
  return (
    <TabbedWorkspaceFrame
      icon={<SmartToyOutlinedIcon />}
      title={agent.title}
      context={
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ alignItems: "center", minWidth: 0, overflow: "hidden" }}
        >
          <AgentHeaderRelationships
            projectLabel={projectLabel}
            chats={chats}
            onOpenProject={onOpenProject}
            onOpenChat={onOpenChat}
          />
          {lineageAgentId ? (
            <>
              <Typography
                variant="caption"
                color="text.secondary"
                aria-hidden="true"
              >
                ·
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {lineageLabel}{" "}
                {lineageAgent ? (
                  <Link
                    component="button"
                    variant="caption"
                    onClick={() => onOpenAgent(lineageAgent.id)}
                  >
                    {lineageAgent.title}
                  </Link>
                ) : (
                  lineageAgentId
                )}
              </Typography>
            </>
          ) : null}
        </Stack>
      }
      status={
        <AgentRunState
          status={status}
          statusLabelOverride={statusLabelOverride}
          health={health}
          connectionStatus={connectionStatus}
          phaseEvidenceFresh={phaseEvidenceFresh}
          startedAt={startedAt}
          agentNameForId={agentNameForId}
        />
      }
      actions={
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          sx={{ alignItems: "center" }}
        >
          {running ? (
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={stopping}
              onClick={onStop}
              sx={{ minHeight: 36 }}
            >
              {stopping ? "Cancelling…" : "Stop"}
            </Button>
          ) : null}
          <ChatOverflowMenu
            label="Agent Chat Actions"
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            showExports={false}
            actions={[
              {
                label: "Technical Details",
                icon: <DataObjectOutlinedIcon fontSize="small" />,
                onSelect: onOpenTechnical,
              },
              {
                label: "Rename",
                icon: <DriveFileRenameOutlineIcon fontSize="small" />,
                onSelect: onRename,
              },
              {
                label: "Create Agent",
                icon: <PersonAddAlt1Icon fontSize="small" />,
                onSelect: onCreateAgent,
              },
              ...(onDuplicate
                ? [
                    {
                      label: "Duplicate…",
                      icon: <ContentCopyOutlinedIcon fontSize="small" />,
                      onSelect: onDuplicate,
                    },
                  ]
                : []),
              {
                label: "Export Agent package…",
                icon: <DownloadOutlinedIcon fontSize="small" />,
                onSelect: onExportPackage,
              },
              {
                label: "Copy chat transcript",
                icon: <ContentCopyOutlinedIcon fontSize="small" />,
                onSelect: () => void copyText(transcriptMarkdown)
                  .then(() => onNotice("Chat transcript copied."))
                  .catch(error => onNotice(error instanceof Error ? error.message : "Chat transcript could not be copied.")),
              },
              {
                label: "Download chat transcript",
                icon: <DownloadOutlinedIcon fontSize="small" />,
                onSelect: () => downloadMarkdownTranscript(transcriptMarkdown, transcriptFileName(transcriptTitle)),
              },
              {
                label: "Delegated Under",
                icon: <AccountTreeOutlinedIcon fontSize="small" />,
                onSelect: onChangeReportingLine,
              },
              {
                label: "Delete",
                icon: <DeleteOutlineIcon fontSize="small" />,
                destructive: true,
                onSelect: onDelete,
              },
            ]}
          />
        </Stack>
      }
      tabs={{
        activeLabel: tab === "technical" ? "Technical details" : undefined,
        label: "Agent details",
        value: tab === "technical" ? false : tab,
        onChange: onTabChange,
        items: AGENT_DETAIL_TABS.filter(item =>
          (item.value !== "subagents" || showSubagents) &&
          (item.value !== "triggers" || showAutomations)
        ),
      }}
    />
  );
}
