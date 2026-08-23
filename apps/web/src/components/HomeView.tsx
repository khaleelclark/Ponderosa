import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type {
  EngineDto,
  ProjectDto,
  WorkspaceAgentDirectoryItemDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
  WorkspaceTriggerDirectoryItemDto,
} from "@ponderosa/core";
import type { ReactNode } from "react";
import { isOpenAttention } from "../attention";
import { engineAvailabilityPresentation } from "../conversationEngine";
import {
  useWorkspaceDirectory,
  workspaceDirectoryItems,
} from "../hooks/useWorkspaceDirectory";
import type { Route } from "../routing";
import { CompactWorkspaceHeader } from "./WorkspaceFrame";

const ACTIVE_STATUSES = new Set([
  "running",
  "waiting",
  "preparing",
  "compacting",
  "blocked",
  "stalled",
  "interrupted",
  "needs_decision",
]);

function humanizeStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase());
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: JSX.Element;
  children: ReactNode;
}): JSX.Element {
  return (
    <Box component="section">
      <Stack direction="row" spacing={2} sx={{ alignItems: "end", mb: 1.25 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h2" fontWeight={800}>{title}</Typography>
          <Typography variant="body2" color="text.secondary">{description}</Typography>
        </Box>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

function SummaryCard({
  label,
  value,
  compactLabel,
  compactValue,
  onClick,
}: {
  label: string;
  value: string | number;
  compactLabel?: string;
  compactValue?: string | number;
  onClick?(): void;
}): JSX.Element {
  const content = (
    <Stack spacing={0.25} sx={{ p: 1.5, minWidth: 0, textAlign: "left" }}>
      <Typography variant="h5" fontWeight={800} noWrap>
        {compactValue === undefined ? value : (
          <><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{compactValue}</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>{value}</Box></>
        )}
      </Typography>
      <Typography variant="body2" color="text.secondary" noWrap>
        {compactLabel === undefined ? label : (
          <><Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>{compactLabel}</Box><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>{label}</Box></>
        )}
      </Typography>
    </Stack>
  );
  return (
    <Paper variant="outlined" sx={{ minWidth: 0, overflow: "hidden" }}>
      {onClick ? (
        <ButtonBase onClick={onClick} sx={{ display: "block", width: "100%" }}>
          {content}
        </ButtonBase>
      ) : content}
    </Paper>
  );
}

function ItemCard({
  icon,
  title,
  detail,
  status,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  detail: string;
  status?: string;
  onClick(): void;
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ minWidth: 0, overflow: "hidden" }}>
      <ButtonBase
        onClick={onClick}
        sx={{ width: "100%", p: 1.35, gap: 1.25, justifyContent: "flex-start", textAlign: "left" }}
      >
        <Box sx={{ width: 36, height: 36, borderRadius: 1.25, bgcolor: "action.selected", color: "text.secondary", display: "grid", placeItems: "center", flexShrink: 0 }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography fontWeight={750} noWrap>{title}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap>{detail}</Typography>
        </Box>
        {status ? <Chip size="small" variant="outlined" label={status} /> : null}
      </ButtonBase>
    </Paper>
  );
}

function notificationRoute(notification: WorkspaceNotificationDto): Route | undefined {
  if (!notification.projectId) return undefined;
  if (notification.action?.kind === "open_agent" && notification.action.targetId) {
    return { kind: "agent", projectId: notification.projectId, agentId: notification.action.targetId };
  }
  if (notification.conversationId) {
    return { kind: "conversation", projectId: notification.projectId, conversationId: notification.conversationId };
  }
  if (notification.agentId) {
    return { kind: "agent", projectId: notification.projectId, agentId: notification.agentId };
  }
  return { kind: "project", projectId: notification.projectId };
}

export function HomeView({
  projects,
  engines,
  notifications,
  preferences,
  onNavigate,
  onCreateProject,
  onOpenInbox,
}: {
  projects: ProjectDto[];
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  onNavigate(route: Route): void;
  onCreateProject(): void;
  onOpenInbox(): void;
}): JSX.Element {
  const directoryOptions = { sort: "last_used" as const };
  const agentQuery = useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", directoryOptions);
  const triggerQuery = useWorkspaceDirectory<WorkspaceTriggerDirectoryItemDto>("trigger", directoryOptions);
  const agentDirectory = workspaceDirectoryItems(agentQuery.data?.pages, preferences);
  const triggerDirectory = workspaceDirectoryItems(triggerQuery.data?.pages, preferences);
  const agentItems = [...agentDirectory.starredItems, ...agentDirectory.items];
  const triggerItems = [...triggerDirectory.starredItems, ...triggerDirectory.items];
  const attention = notifications
    .filter(isOpenAttention)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const working = agentItems
    .filter(item => ACTIVE_STATUSES.has(item.health.status))
    .sort((left, right) => right.health.statusTimestamp.localeCompare(left.health.statusTimestamp));
  const automations = triggerItems
    .slice()
    .sort((left, right) => {
      if (left.trigger.enabled !== right.trigger.enabled) return left.trigger.enabled ? -1 : 1;
      return (left.trigger.nextFireAt ?? "~").localeCompare(right.trigger.nextFireAt ?? "~");
    });
  const recentOutcomes = agentItems
    .filter(item => item.health.assignedWorkOutcome)
    .sort((left, right) =>
      (right.health.assignedWorkOutcome?.updatedAt ?? "").localeCompare(
        left.health.assignedWorkOutcome?.updatedAt ?? "",
      ))
    .slice(0, 6);
  const provider = engineAvailabilityPresentation(engines);
  const activeCount = agentQuery.requestState.hasResolved
    ? agentQuery.data?.pages.at(-1)?.activeCount ?? 0
    : "—";
  const enabledAutomationCount = triggerQuery.requestState.hasResolved
    ? triggerItems.filter(item => item.trigger.enabled).length
    : "—";

  return (
    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto" }}>
      <CompactWorkspaceHeader
        icon={<HomeOutlinedIcon />}
        title="Home"
        context="Across every Project"
      />
      <Box sx={{ p: { xs: 2, sm: 3, lg: 4 } }}>
        <Stack spacing={3} sx={{ width: "100%", maxWidth: 1320, mx: "auto" }}>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 1.25 }}>
            <SummaryCard label="Active Agents" value={activeCount} onClick={() => onNavigate({ kind: "allAgents" })} />
            <SummaryCard label="Needs Attention" value={attention.length} onClick={onOpenInbox} />
            <SummaryCard label="Enabled Automations" compactLabel="Automations" value={enabledAutomationCount} onClick={() => onNavigate({ kind: "allTriggers" })} />
            <SummaryCard label="Provider Health" value={provider.label} compactValue={provider.label === "Engine ready" ? "Ready" : provider.label} />
          </Box>

          {projects.length === 0 ? (
            <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
              <FolderOutlinedIcon color="action" sx={{ fontSize: 42, mb: 1 }} />
              <Typography variant="h6" fontWeight={800}>Create Your First Project</Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                Projects organize the Chats, Agents, files, and Automations for a workstream.
              </Typography>
              <Button variant="contained" onClick={onCreateProject}>Create Project</Button>
            </Paper>
          ) : null}

          <Section
            title="Needs Attention"
            description="Decisions, blockers, and failures that still need you."
            action={attention.length ? <Button onClick={onOpenInbox}>View all</Button> : undefined}
          >
            {attention.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {attention.slice(0, 6).map(item => {
                  const route = notificationRoute(item);
                  return (
                    <ItemCard
                      key={item.id}
                      icon={<WarningAmberOutlinedIcon color="warning" />}
                      title={item.title}
                      detail={item.body}
                      status={item.severity === "urgent" ? "Urgent" : "Review"}
                      onClick={() => route ? onNavigate(route) : onOpenInbox()}
                    />
                  );
                })}
              </Box>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <CheckCircleOutlineIcon color="success" />
                  <Typography color="text.secondary">Nothing currently needs your attention.</Typography>
                </Stack>
              </Paper>
            )}
          </Section>

          <Section
            title="Working Now"
            description="Active and waiting Agent work across the organization."
            action={<Button onClick={() => onNavigate({ kind: "allAgents" })}>View all Agents</Button>}
          >
            {working.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {working.slice(0, 8).map(item => (
                  <ItemCard
                    key={item.agent.id}
                    icon={<SmartToyOutlinedIcon />}
                    title={item.agent.title}
                    detail={item.project.label}
                    status={humanizeStatus(item.health.status)}
                    onClick={() => onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.agent.id })}
                  />
                ))}
              </Box>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">No Agents are active right now.</Typography></Paper>
            )}
          </Section>

          <Section
            title="Automations"
            description="Enabled schedules and events, ordered by what runs next."
            action={<Button onClick={() => onNavigate({ kind: "allTriggers" })}>View all Automations</Button>}
          >
            {automations.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {automations.slice(0, 8).map(item => (
                  <ItemCard
                    key={item.trigger.id}
                    icon={<BoltOutlinedIcon />}
                    title={item.trigger.name}
                    detail={`${item.project.label} · ${item.agent.title}`}
                    status={item.trigger.enabled ? "Enabled" : "Disabled"}
                    onClick={() => onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.agent.id, view: "triggers", triggerId: item.trigger.id })}
                  />
                ))}
              </Box>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">No Automations have been configured yet.</Typography></Paper>
            )}
          </Section>

          <Section title="Recent Outcomes" description="The latest finished assigned work across Projects.">
            {recentOutcomes.length ? (
              <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, gap: 1 }}>
                {recentOutcomes.map(item => (
                  <ItemCard
                    key={item.agent.id}
                    icon={<CheckCircleOutlineIcon />}
                    title={item.agent.title}
                    detail={item.project.label}
                    status={humanizeStatus(item.health.assignedWorkOutcome!.status)}
                    onClick={() => onNavigate({ kind: "agent", projectId: item.project.id, agentId: item.agent.id })}
                  />
                ))}
              </Box>
            ) : (
              <Paper variant="outlined" sx={{ p: 2 }}><Typography color="text.secondary">Completed Agent work will appear here.</Typography></Paper>
            )}
          </Section>
        </Stack>
      </Box>
    </Box>
  );
}
