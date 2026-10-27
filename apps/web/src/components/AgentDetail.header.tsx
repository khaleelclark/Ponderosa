import {useWorkspaceReadOnly} from "./WorkspaceReadOnlyContext";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
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
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import { Box, Button, IconButton, Link, Popover, Stack, Tooltip, Typography, useMediaQuery } from "@mui/material";
import { useState } from "react";
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
import { useMutationNotification } from "./MutationNotifications";
import type { AgentTab } from "./AgentDetail.helpers";
import {
  AgentHeaderRelationships,
  type AgentHeaderChat,
} from "./HeaderRelationshipLinks";
import { TabbedWorkspaceFrame } from "./WorkspaceFrame";
import { useAgentRunClock } from "./useAgentRunClock";
import type { WorkspaceConnectionStatus } from "../hooks/useWorkspaceStream";
import { SemanticStatus, semanticStatusColorToken } from "./SemanticStatus";

export const AGENT_DETAIL_TABS: Array<{
  value: AgentTab;
  label: string;
  icon: JSX.Element;
}> = [
  { value: "chat", label: "Chat", icon: <ChatBubbleOutlineIcon /> },
  { value: "subagents", label: "Subagents", icon: <AccountTreeOutlinedIcon /> },
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
  phaseEvidenceFresh,
  startedAt,
  agentNameForId,
}: {
  status: AgentStatus;
  health?: AgentHealthDto;
  connectionStatus: WorkspaceConnectionStatus;
  phaseEvidenceFresh: boolean;
  startedAt?: string;
  agentNameForId(agentId: string): string | undefined;
}): JSX.Element {
  const mobile = useMediaQuery("(max-width: 899.95px)");
  const [detailAnchor, setDetailAnchor] = useState<HTMLElement | null>(null);
  const now = useAgentRunClock(startedAt);
  const presentation = agentStatusPresentation(health, {
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
  const details = [
    "Current: " + presentation.detail,
    health?.latestRun ? "Latest Run: " + agentStatusLabel(health.latestRun.status) : undefined,
    health?.assignedWorkOutcome ? "Assigned work: " + agentStatusLabel(health.assignedWorkOutcome.status) : undefined,
    health?.attention ? "Needs attention: " + agentStatusLabel(health.attention.status) : undefined,
  ].filter(Boolean).join(" · ");
  const delayed = connectionStatus === "stale" || connectionStatus === "unavailable";
  const accessibleDetail = `${presentation.accessibleLabel}${elapsed ? `; ${elapsed}` : ""}; ${connectionState.toLocaleLowerCase()}. ${details}`;
  if (mobile) return <>
    <Tooltip title={accessibleDetail}><IconButton size="small" aria-label={accessibleDetail}
      onClick={event => setDetailAnchor(event.currentTarget)} sx={{ width: 44, height: 44 }}>
      <Box component="span" sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: theme => semanticStatusColorToken(presentation.status, theme.palette.mode) }} />
    </IconButton></Tooltip>
    <Popover open={Boolean(detailAnchor)} anchorEl={detailAnchor} onClose={() => setDetailAnchor(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
      <Typography role="status" variant="body2" sx={{ p: 1.5, maxWidth: "min(320px, calc(100vw - 32px))" }}>{accessibleDetail}</Typography>
    </Popover>
  </>;
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap" alignItems="center" sx={{ minWidth: 0, flexShrink: 1 }}>
      <SemanticStatus
        status={presentation.status}
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
  health?: AgentHealthDto;
  connectionStatus: WorkspaceConnectionStatus;
  phaseEvidenceFresh: boolean;
  startedAt?: string;
  agentNameForId(agentId: string): string | undefined;
  running: boolean;
  stopping: boolean;
  tab: AgentTab;
  showSubagents: boolean;
  transcriptMarkdown: string;
  transcriptTitle: string;
  onOpenProject(): void;
  onOpenChat(conversationId: string): void;
  onOpenAgent(agentId: string): void;
  onStop(): void;
  onExportPackage(): void;
  onDuplicate?(): void;
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
  connectionStatus,
  phaseEvidenceFresh,
  startedAt,
  agentNameForId,
  running,
  stopping,
  tab,
  showSubagents,
  transcriptMarkdown,
  transcriptTitle,
  onOpenProject,
  onOpenChat,
  onOpenAgent,
  onStop,
  onExportPackage,
  onDuplicate,
  onOpenTechnical,
  onRename,
  onCreateAgent,
  onChangeReportingLine,
  onDelete,
  onTabChange,
}: AgentDetailHeaderProps): JSX.Element {
  const auditOnly=useWorkspaceReadOnly();
  const notify=useMutationNotification();
  return (
    <TabbedWorkspaceFrame
      compactMobile
      actionsInMobileTabs
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
      status={<Stack direction="row" sx={{ alignItems: "center" }}>
        <AgentRunState
          status={status}
          health={health}
          connectionStatus={connectionStatus}
          phaseEvidenceFresh={phaseEvidenceFresh}
          startedAt={startedAt}
          agentNameForId={agentNameForId}
        />
        {running && !auditOnly ? <Tooltip title={stopping ? "Cancelling…" : "Stop"}><IconButton color="error" disabled={stopping} onClick={onStop}
          aria-label={stopping ? "Cancelling…" : "Stop"} sx={{ display: { xs: "inline-flex", md: "none" }, width: 44, height: 44 }}><StopCircleOutlinedIcon /></IconButton></Tooltip> : null}
      </Stack>}
      actions={
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          sx={{ alignItems: "center" }}
        >
          {running && !auditOnly ? (
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={stopping}
              onClick={onStop}
              sx={{ minHeight: 36, display: { xs: "none", md: "inline-flex" } }}
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
                  .then(() => notify({ key: "copy-transcript", message: "Copied" }))
                  .catch(error => notify({ key: "copy-transcript", message: error instanceof Error ? error.message : "Chat transcript could not be copied.", severity: "error" })),
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
            ].filter(action=>!auditOnly||["Technical Details","Copy chat transcript","Download chat transcript"].includes(action.label))}
          />
        </Stack>
      }
      tabs={{
        activeLabel: tab === "technical" ? "Technical details" : undefined,
        label: "Agent details",
        value: tab === "technical" ? false : tab,
        onChange: onTabChange,
        items: AGENT_DETAIL_TABS.filter(item =>
          (!auditOnly||!["subagents","settings"].includes(item.value)) && (item.value !== "subagents" || showSubagents)
        ),
      }}
    />
  );
}
