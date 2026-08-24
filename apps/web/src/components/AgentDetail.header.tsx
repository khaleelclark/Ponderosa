import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { Button, Chip, Link, Stack, Typography } from "@mui/material";
import type { AgentDto, AgentHealthDto } from "@ponderosa/core";
import {
  agentStatusColor,
  agentStatusLabel,
  agentStatusPresentation,
  type AgentStatus,
} from "../agents";
import { transcriptFileName } from "../chatTranscript";
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
  health,
  connectionStatus,
  startedAt,
  agentNameForId,
}: {
  status: AgentStatus;
  health?: AgentHealthDto;
  connectionStatus: WorkspaceConnectionStatus;
  startedAt?: string;
  agentNameForId(agentId: string): string | undefined;
}): JSX.Element {
  const now = useAgentRunClock(startedAt);
  const presentation = agentStatusPresentation(health, {
    status,
    connectionStatus,
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
  const details = [
    "Current: " + presentation.detail,
    health?.latestRun ? "Latest Run: " + agentStatusLabel(health.latestRun.status) : undefined,
    health?.assignedWorkOutcome ? "Assigned work: " + agentStatusLabel(health.assignedWorkOutcome.status) : undefined,
    health?.attention ? "Needs attention: " + agentStatusLabel(health.attention.status) : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <Chip
      size="small"
      label={`${runState} · ${connectionState}`}
      color={connectionStatus === "live" ? agentStatusColor(status) : "warning"}
      variant={connectionStatus === "live" ? "filled" : "outlined"}
      aria-label={`${presentation.accessibleLabel}${elapsed ? `; ${elapsed}` : ""}; ${connectionState.toLocaleLowerCase()}`}
      title={details}
    />
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
  health?: AgentHealthDto;
  connectionStatus: WorkspaceConnectionStatus;
  startedAt?: string;
  agentNameForId(agentId: string): string | undefined;
  running: boolean;
  stopping: boolean;
  tab: AgentTab;
  transcriptMarkdown: string;
  transcriptTitle: string;
  onOpenProject(): void;
  onOpenChat(conversationId: string): void;
  onOpenAgent(agentId: string): void;
  onStop(): void;
  onCopyPackage(mode: "template" | "full", organization?: boolean): void;
  onDownloadPackage(mode: "template" | "full", organization?: boolean): void;
  onOpenTechnical(): void;
  onRename(): void;
  onCreateAgent(): void;
  onAssignChats(): void;
  onQuickCopy?: () => void;
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
  connectionStatus,
  startedAt,
  agentNameForId,
  running,
  stopping,
  tab,
  transcriptMarkdown,
  transcriptTitle,
  onOpenProject,
  onOpenChat,
  onOpenAgent,
  onStop,
  onCopyPackage,
  onDownloadPackage,
  onOpenTechnical,
  onRename,
  onCreateAgent,
  onAssignChats,
  onQuickCopy,
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
          health={health}
          connectionStatus={connectionStatus}
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
            copyActions={[
              { label: "Agent Template", onSelect: () => onCopyPackage("template") },
              { label: "Full Agent", onSelect: () => onCopyPackage("full") },
              {
                label: "Organization Template",
                onSelect: () => onCopyPackage("template", true),
              },
              {
                label: "Full Organization",
                onSelect: () => onCopyPackage("full", true),
              },
            ]}
            downloadActions={[
              {
                label: "Agent Template",
                onSelect: () => onDownloadPackage("template"),
              },
              {
                label: "Full Agent",
                onSelect: () => onDownloadPackage("full"),
              },
              {
                label: "Organization Template",
                onSelect: () => onDownloadPackage("template", true),
              },
              {
                label: "Full Organization",
                onSelect: () => onDownloadPackage("full", true),
              },
            ]}
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
              {
                label: "Assign Chats",
                icon: <ForumOutlinedIcon fontSize="small" />,
                onSelect: onAssignChats,
              },
              ...(onQuickCopy
                ? [
                    {
                      label: "Duplicate Agent into Project Chat",
                      icon: <ContentCopyOutlinedIcon fontSize="small" />,
                      onSelect: onQuickCopy,
                    },
                  ]
                : []),
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
        items: AGENT_DETAIL_TABS,
      }}
    />
  );
}
