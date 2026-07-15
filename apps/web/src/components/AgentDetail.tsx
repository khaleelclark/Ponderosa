import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import FolderCopyOutlinedIcon from "@mui/icons-material/FolderCopyOutlined";
import TaskAltOutlinedIcon from "@mui/icons-material/TaskAltOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import TimelineIcon from "@mui/icons-material/Timeline";
import DifferenceOutlinedIcon from "@mui/icons-material/DifferenceOutlined";
import PsychologyOutlinedIcon from "@mui/icons-material/PsychologyOutlined";
import TuneIcon from "@mui/icons-material/Tune";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  Link,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { AgentHealthDto, EngineCommand, EngineDto, ConversationDetailDto, ConversationDto, MessageDto, ProjectEngineCapabilitiesDto, SendMessageRequest, AgentDetailDto, AgentDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { agentDescendants, agentStatusColor, agentStatusLabel, deriveAgentStatus, type AgentStatus } from "../agents";
import { useAgent } from "../hooks/queries";
import { useSendMessage } from "../hooks/useSendMessage";
import { useAgentStream } from "../hooks/useAgentStream";
import { agentIdForMentionHandle } from "../mentions";
import { compactViewportQuery } from "../responsive";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { effortOptionsForModel, effortSelectionIsCompatible, modelSelectionIsCompatible } from "../conversationEngine";
import { ActivityPane, ArtifactsPane, ChangedFilesPane, ChatPane, Composer, RunsPane, WorkLogPane, WorkspaceReviewPane } from "./panes";
import { TokenUsageButton } from "./TokenUsageButton";

type AgentTab = "chat" | "runOutput" | "activity" | "changed_files" | "review" | "runs" | "artifacts";

export function formatExecutionElapsed(startedAt: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function RespondingIndicator({ agentName, startedAt }: { agentName: string; startedAt: string }): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <Typography variant="body2" color="info.main" role="status" aria-live="polite">
      {agentName} is responding · {formatExecutionElapsed(startedAt, now)}
    </Typography>
  );
}

const AGENT_DETAIL_TABS: Array<{ value: AgentTab; label: string; icon: JSX.Element }> = [
  { value: "chat", label: "Chat", icon: <ChatBubbleOutlineIcon /> },
  { value: "runOutput", label: "Work log", icon: <PsychologyOutlinedIcon /> },
  { value: "activity", label: "Activity", icon: <TimelineIcon /> },
  { value: "changed_files", label: "Changed Files", icon: <FolderCopyOutlinedIcon /> },
  { value: "review", label: "Review", icon: <DifferenceOutlinedIcon /> },
  { value: "runs", label: "Runs", icon: <TaskAltOutlinedIcon /> },
  { value: "artifacts", label: "Files & results", icon: <Inventory2OutlinedIcon /> },
];

export const AGENT_DETAIL_TAB_LABELS = AGENT_DETAIL_TABS.map(({ label }) => label);

export function eligibleOrganizationParents(agent: AgentDto, agents: AgentDto[]): AgentDto[] {
  const byId = new Map(agents.map((candidate) => [candidate.id, candidate]));
  const isDescendant = (candidate: AgentDto): boolean => {
    const seen = new Set<string>();
    let parentId = candidate.managerAgentId;
    while (parentId && !seen.has(parentId)) {
      if (parentId === agent.id) return true;
      seen.add(parentId);
      parentId = byId.get(parentId)?.managerAgentId;
    }
    return false;
  };
  return agents
    .filter((candidate) => candidate.id !== agent.id && candidate.projectId === agent.projectId && !candidate.archived && !isDescendant(candidate))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function AgentDetail({
  agentId,
  engines,
  engineCapabilities,
  projectedStatus,
  projectedHealth,
  agents,
  conversations,
  onBack,
  onOpenAgent,
  onOpenMaster,
  onNewSubagent,
  onDeleted,
}: {
  agentId: string;
  engines: EngineDto[];
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  projectedStatus?: AgentStatus;
  projectedHealth?: AgentHealthDto;
  agents: AgentDto[];
  conversations: ConversationDto[];
  onBack(): void;
  onOpenAgent(agentId: string): void;
  onOpenMaster(conversationId: string): void;
  onNewSubagent(managerAgentId: string): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const agentQuery = useAgent(agentId);
  const stream = useAgentStream(agentId);
  const sendMessage = useSendMessage(agentId);
  const [tab, setTab] = useState<AgentTab>(() => {
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    return AGENT_DETAIL_TABS.some((item) => item.value === saved) ? saved as AgentTab : "chat";
  });
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationParentId, setOrganizationParentId] = useState("");
  const [membershipIds, setMembershipIds] = useState<string[]>([]);
  const [primaryConversationId, setPrimaryConversationId] = useState("");
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<MessageDto | undefined>();
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const theme = useTheme();
  const compactViewport = useMediaQuery(compactViewportQuery(theme.breakpoints.down("sm")));

  useEffect(() => {
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    setTab(AGENT_DETAIL_TABS.some((item) => item.value === saved) ? saved as AgentTab : "chat");
  }, [agentId]);

  useEffect(() => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), tab);
  }, [agentId, tab]);

  const detail = agentQuery.data;
  const engine =
    engines.find((candidate) => candidate.id === detail?.agent.activeEngine) ?? engines[0];
  const engineCapability = engineCapabilities.find((item) => item.engineId === engine?.id);
  const commands: EngineCommand[] = [
    { name: "cancel", description: "Stop the active agent turn", source: "ponderosa", acceptsArguments: false },
    { name: "compact", description: "Compact this agent session", source: "ponderosa", acceptsArguments: false },
    { name: "status", description: "Show this agent's runtime status", source: "ponderosa", acceptsArguments: false },
    ...(engineCapability?.commands ?? []),
  ];

  const latestRun = detail?.runs.at(-1);
  const persistedModel = detail
    ? latestRun ? latestRun.model ?? "" : detail.agent.model ?? ""
    : "";
  const persistedEffort = detail
    ? latestRun ? latestRun.effort ?? "" : detail.agent.effort ?? ""
    : "";

  useEffect(() => {
    setModel(persistedModel);
    setEffort(persistedEffort);
  }, [agentId, persistedModel, persistedEffort]);

  useEffect(() => {
    if (!engine) {
      setModel("");
      setEffort("");
      return;
    }
    if (engine.modelCatalogKnown === false) return;
    setModel((current) => (modelSelectionIsCompatible(engine, current) ? current : ""));
    setEffort((current) => (
      effortSelectionIsCompatible(engine, model, current) ? current : ""
    ));
  }, [engine, model]);

  const runtimeActivity = projectedHealth?.runtimeActivity;
  const running = Boolean(runtimeActivity) || sendMessage.isPending;

  const errorHint = useMemo(
    () => stream.timeline.at(-1)?.event.type === "error",
    [stream.timeline],
  );
  const status = runtimeActivity ? "running" : errorHint ? "failed" : projectedStatus ?? deriveAgentStatus(detail);
  const connectedMcps = engineCapability?.mcpServers.filter((server) => server.status === "connected") ?? [];
  const mcpSummary = engineCapability?.mcpServers.map((server) => `${server.name}: ${server.status}`).join("\n") || "No inherited MCP servers reported by this engine.";

  const cancelRun = useMutation({
    mutationFn: () => api.cancelRun(agentId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["agent", agentId] }),
  });

  const deleteAgent = useMutation({
    mutationFn: () => api.deleteAgent(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.removeQueries({ queryKey: ["agent", agentId] });
      setDeleteOpen(false);
      onDeleted();
    },
  });

  const rename = useMutation({
    mutationFn: (title: string) => api.updateAgent(agentId, { title }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentDetailDto>(["agent", agentId], (current) =>
        current ? { ...current, agent: updated } : current,
      );
      queryClient.setQueriesData<AgentDto[]>({ queryKey: ["agents"] }, (current) =>
        current?.map((agent) => (agent.id === updated.id ? updated : agent)),
      );
      queryClient.setQueriesData<ConversationDetailDto>({ queryKey: ["conversation"] }, (current) =>
        current
          ? {
              ...current,
              agents: current.agents.map((agent) => (agent.id === updated.id ? updated : agent)),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation"] });
      setRenameOpen(false);
    },
  });

  const updateMemberships = useMutation({
    mutationFn: () => api.updateAgentConversationMemberships(agentId, {
      conversationIds: membershipIds,
      primaryConversationId: membershipIds.length ? primaryConversationId : undefined,
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentDetailDto>(["agent", agentId], (current) =>
        current ? { ...current, agent: updated } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation"] });
      setMembershipOpen(false);
    },
  });

  const updateOrganization = useMutation({
    mutationFn: () => api.updateAgentOrganization(agentId, { managerAgentId: organizationParentId || null }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentDetailDto>(["agent", agentId], (current) =>
        current ? { ...current, agent: updated } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["agents", updated.projectId] });
      setOrganizationOpen(false);
    },
  });

  if (agentQuery.isLoading) {
    return (
      <Box sx={{ p: 3 }} role="status" aria-live="polite">
        <CircularProgress size={24} aria-label="Loading agent" />
      </Box>
    );
  }

  if (agentQuery.isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void agentQuery.refetch()}>
              Retry
            </Button>
          }
        >
          This agent could not be loaded. Check the server connection and try again.
        </Alert>
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">Agent not found.</Alert>
      </Box>
    );
  }

  const advertisedModels = engine?.models.filter((option) => option.id) ?? [];
  const models = engine?.modelCatalogKnown === false && model && !advertisedModels.some((option) => option.id === model)
    ? [...advertisedModels, { id: model, label: `${model} (saved selection)` }]
    : advertisedModels;
  const advertisedEfforts = effortOptionsForModel(engine, model);
  const efforts = effort && effortSelectionIsCompatible(engine, model, effort) && !advertisedEfforts.some((option) => option.id === effort)
    ? [...advertisedEfforts, { id: effort, label: `${effort} (saved selection)` }]
    : advertisedEfforts;
  const master = detail.agent.conversationId
    ? conversations.find((candidate) => candidate.id === detail.agent.conversationId)
    : undefined;
  const agentIdForHandle = (handle: string): string | undefined => agentIdForMentionHandle(agents, handle);
  const agentNameForId = (candidateId: string): string | undefined =>
    agents.find((candidate) => candidate.id === candidateId)?.title;
  const organizationalParent = detail.agent.managerAgentId
    ? agents.find((candidate) => candidate.id === detail.agent.managerAgentId)
    : undefined;
  const spawningAgent = detail.agent.spawnedByAgentId
    ? agents.find((candidate) => candidate.id === detail.agent.spawnedByAgentId)
    : undefined;
  const descendantCount = agentDescendants(detail.agent.id, agents).length;

  const submitAgentMessage = (activeRunDelivery: NonNullable<SendMessageRequest["activeRunDelivery"]>) =>
    (text: string, files: File[]) => {
      const sent = Promise.all(files.map((file) => api.uploadAttachment(agentId, file))).then(async (attachments) => {
        try {
          return await sendMessage.mutateAsync(
            {
              text,
              attachmentIds: attachments.map((item) => item.id),
              model,
              effort: effortSelectionIsCompatible(engine, model, effort) ? effort : "",
              replyToMessageId: replyTo?.id,
              activeRunDelivery,
            },
            {
              onSuccess: (response) => {
                setReplyTo(undefined);
                setQueuedMessageNotice(
                  response.queued
                    ? `Queued in position ${response.position}; it will start when the current response finishes.`
                    : response.steered
                      ? "Steered into the active turn."
                      : undefined,
                );
                void queryClient.invalidateQueries({ queryKey: ["agent-health", detail.agent.projectId] });
              },
            },
          );
        } catch (error) {
          await Promise.allSettled(attachments.map((item) => api.deleteAttachment(agentId, item.id)));
          throw error;
        }
      });
      setTab("chat");
      return sent;
    };

  const panes: Record<AgentTab, JSX.Element> = {
    chat: <ChatPane messages={detail.messages} agentName={detail.agent.title} agentNameForId={agentNameForId} agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent} scrollStorageKey={chatStateKey("scroll", `agent.${agentId}`)} onReact={(message, emoji) => api.sendUserReaction({
      projectId: detail.agent.projectId,
      communicationEventId: message.communicationEventId!,
      emoji,
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    })} onReply={setReplyTo} />,
    runOutput: <WorkLogPane entries={detail.runOutput} />,
    activity: <ActivityPane activity={detail.activity} connected={stream.connected} running={stream.running} activeExecutionId={runtimeActivity?.executionId} />,
    changed_files: <ChangedFilesPane files={detail.changedFiles} />,
    review: <WorkspaceReviewPane projectId={detail.agent.projectId} files={detail.changedFiles} running={stream.running} initialPath={readChatState(chatStateKey("view", `agent.${agentId}.review-file`))} />,
    runs: <RunsPane runs={detail.runs} activeWait={detail.activeWait} workItems={detail.workItems} runTriggers={detail.runTriggers} messages={detail.messages} timeline={stream.timeline} />,
    artifacts: <ArtifactsPane artifacts={detail.artifacts} agentId={agentId} timeline={stream.timeline} />,
  };

  return (
    <Box data-testid="agent-detail" data-agent-id={agentId} sx={{ minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr) auto" }}>
      <Box sx={{ px: { xs: 1, sm: 1.5, md: 2 }, py: { xs: 0.75, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          sx={{ alignItems: "center", minWidth: 0 }}
        >
          <Tooltip title="Back to agents">
            <IconButton aria-label="Back to agents" onClick={onBack} edge="start" sx={{ minWidth: 44, minHeight: 44 }}>
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Box sx={{ minWidth: 0, flex: 1, flexBasis: { xs: "calc(100% - 48px)", sm: "auto" } }}>
            <Typography variant="h6" noWrap>
              {detail.agent.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {detail.state.branch ?? "No branch"} {detail.state.commit ? `· ${detail.state.commit}` : ""}
              {master ? (
                <>
                  {" · "}
                  <Link component="button" variant="body2" onClick={() => onOpenMaster(master.id)}>
                    {master.title}
                  </Link>
                </>
              ) : (
                " · Unassigned"
              )}
            </Typography>
          </Box>
          <TokenUsageButton scope="agent" scopeId={agentId} label={detail.agent.title} />
          <Chip size="small" label={agentStatusLabel(status)} color={agentStatusColor(status)} aria-label={`Agent status: ${agentStatusLabel(status)}`} />
          {engineCapability?.steering ? <Chip size="small" color="info" variant="outlined" label="Steerable" /> : null}
          <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{mcpSummary}</span>}>
            <Chip
              size="small"
              variant="outlined"
              color={connectedMcps.length > 0 ? "success" : "default"}
              label={`${connectedMcps.length}/${engineCapability?.mcpServers.length ?? 0} MCPs`}
              aria-label={`${connectedMcps.length} of ${engineCapability?.mcpServers.length ?? 0} inherited MCP servers connected`}
            />
          </Tooltip>
          {organizationalParent ? (
            <Chip
              size="small"
              variant="outlined"
              icon={<AccountTreeOutlinedIcon />}
              label={`Reports to ${organizationalParent.title}`}
              clickable
              onClick={() => onOpenAgent(organizationalParent.id)}
            />
          ) : <Chip size="small" variant="outlined" icon={<AccountTreeOutlinedIcon />} label="Top level" />}
          <Chip
            size="small"
            label={stream.connected ? "Live" : "Reconnecting"}
            color={stream.connected ? "success" : "warning"}
            variant={stream.connected ? "filled" : "outlined"}
          />
          {running ? (
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={cancelRun.isPending}
              onClick={() => cancelRun.mutate()}
              sx={{ minHeight: compactViewport ? 44 : undefined }}
            >
              {cancelRun.isPending ? "Stopping…" : "Cancel"}
            </Button>
          ) : null}
          <Tooltip title="Rename agent">
            <IconButton
              aria-label="Rename agent"
              sx={{ minWidth: 44, minHeight: 44 }}
              onClick={() => {
                setRenameValue(detail.agent.title);
                setRenameOpen(true);
              }}
            >
              <DriveFileRenameOutlineIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete agent">
            <IconButton aria-label="Delete agent" onClick={() => setDeleteOpen(true)} sx={{ minWidth: 44, minHeight: 44 }}>
              <DeleteOutlineIcon />
            </IconButton>
          </Tooltip>
          <Button size="small" variant="outlined" sx={{ minHeight: compactViewport ? 44 : undefined }} onClick={() => {
            setMembershipIds(detail.agent.conversationIds);
            setPrimaryConversationId(detail.agent.conversationId ?? "");
            setMembershipOpen(true);
          }}>
            Assign chats
          </Button>
          <Button size="small" variant="outlined" startIcon={<AccountTreeOutlinedIcon />} sx={{ minHeight: compactViewport ? 44 : undefined }} onClick={() => {
            setOrganizationParentId(detail.agent.managerAgentId ?? "");
            setOrganizationOpen(true);
          }}>
            Organize
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<PersonAddAlt1Icon />}
            sx={{ minHeight: compactViewport ? 44 : undefined }}
            onClick={() => onNewSubagent(agentId)}
          >
            Add report
          </Button>
          {compactViewport ? (
            <Button
              size="small"
              variant={runSetupOpen ? "contained" : "outlined"}
              startIcon={<TuneIcon />}
              onClick={() => setRunSetupOpen((open) => !open)}
              aria-expanded={runSetupOpen}
              aria-controls="agent-run-setup"
              sx={{ minHeight: 44 }}
            >
              Setup
            </Button>
          ) : null}
        </Stack>
        <Stack
          id="agent-run-setup"
          direction={{ xs: "column", sm: "row" }}
          spacing={1}
          sx={{ mt: 1, display: compactViewport && !runSetupOpen ? "none" : "flex" }}
        >
          <Chip
            label={`${engine?.displayName ?? detail.agent.activeEngine}${engine?.authenticated ? "" : " · not signed in"}`}
            color={engine?.authenticated ? "default" : "warning"}
            sx={{ justifyContent: "flex-start" }}
          />
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 180 } }}>
            <InputLabel id="agent-detail-model-label">Model</InputLabel>
            <Select
              labelId="agent-detail-model-label"
              value={models.some((o) => o.id === model) ? model : ""}
              label="Model"
              onChange={(event: SelectChangeEvent) => {
                const nextModel = event.target.value;
                setModel(nextModel);
                if (!effortSelectionIsCompatible(engine, nextModel, effort)) setEffort("");
              }}
            >
              <MenuItem value="">Engine default</MenuItem>
              {models.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 140 } }}>
            <InputLabel id="agent-detail-effort-label">Effort</InputLabel>
            <Select
              labelId="agent-detail-effort-label"
              value={efforts.some((o) => o.id === effort) ? effort : ""}
              label="Effort"
              onChange={(event: SelectChangeEvent) => setEffort(event.target.value)}
            >
              <MenuItem value="">Engine default</MenuItem>
              {efforts.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        {running ? <LinearProgress aria-label="Agent is running" sx={{ mt: 1 }} /> : null}
        {runtimeActivity ? <RespondingIndicator agentName={detail.agent.title} startedAt={runtimeActivity.startedAt} /> : null}
        {detail.agent.spawnedByAgentId ? <Box component="section" aria-label="Agent creation" sx={{ mt: 1.5, p: 1.5, border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
            <Typography fontWeight={700} sx={{ flex: 1 }}>Created by {spawningAgent?.title ?? detail.agent.spawnedByAgentId}</Typography>
            {spawningAgent ? <Button size="small" onClick={() => onOpenAgent(spawningAgent.id)}>Open manager</Button> : null}
          </Stack>
          <Typography variant="overline" color="text.secondary">Original message</Typography>
          <Typography component="pre" variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", m: 0 }}>
            {detail.agent.spawnPrompt ?? "No initial message — this agent was created idle."}
          </Typography>
          {detail.agent.spawnedByExecutionId ? <Typography variant="caption" color="text.secondary">Created during run {detail.agent.spawnedByExecutionId}</Typography> : null}
        </Box> : null}
      </Box>

      <Tabs
        aria-label="Agent details"
        value={tab}
        onChange={(_event, value: AgentTab) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 48, maxWidth: "100%" }}
      >
        {AGENT_DETAIL_TABS.map((item) => <Tab key={item.value} value={item.value} icon={item.icon} iconPosition="start" label={item.label} sx={{ minHeight: 48 }} />)}
      </Tabs>

      <Box role="tabpanel" aria-label={`${tab === "changed_files" ? "Changed files" : tab[0]!.toUpperCase() + tab.slice(1)} panel`} tabIndex={0} sx={{ minHeight: 0, minWidth: 0, overflow: tab === "chat" ? "hidden" : "auto", outlineOffset: -2 }}>{panes[tab]}</Box>

      <Box sx={{ minWidth: 0 }}>
        {queuedMessageNotice ? <Alert severity="info" role="status" aria-live="polite" sx={{ mx: 1.5, mt: 1 }}>{queuedMessageNotice}</Alert> : null}
        {runtimeActivity ? (
          <Alert severity="info" sx={{ mx: 1.5, mt: 1 }}>
            Send steers the active response. Choose Queue to deliver the draft after it finishes.
          </Alert>
        ) : null}
        {sendMessage.isError || cancelRun.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            {sendMessage.isError ? "Message not sent." : "The agent could not be stopped."}{" "}
            {String((sendMessage.error ?? cancelRun.error) as Error)}
          </Alert>
        ) : null}
        <Composer
          commands={commands}
          projectId={detail.agent.projectId}
          draftStorageKey={chatStateKey("draft", `agent.${agentId}`)}
          conversationDraftId={`agent:${agentId}`}
          disabled={sendMessage.isPending}
          running={false}
          placeholder={runtimeActivity ? "Steer this agent's active response" : "Message this agent directly"}
          agentResponding={Boolean(runtimeActivity)}
          onSend={(text, files) => {
            if (files.length === 0 && text === "/cancel") {
              setQueuedMessageNotice("Cancelling the active turn…");
              return cancelRun.mutateAsync().then(() => setQueuedMessageNotice("Active turn cancelled."));
            }
            if (files.length === 0 && text === "/compact") {
              setQueuedMessageNotice("Compacting this agent session…");
              return api.compactSession(agentId).then(() => setQueuedMessageNotice("Agent session compacted."));
            }
            if (files.length === 0 && text === "/status") {
              setQueuedMessageNotice(`${detail.agent.title} is ${agentStatusLabel(status).toLocaleLowerCase()}.`);
              return Promise.resolve();
            }
            return submitAgentMessage("steer")(text, files);
          }}
          onQueue={runtimeActivity ? submitAgentMessage("queue") : undefined}
          onCancel={() => cancelRun.mutate()}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(undefined)}
        />
      </Box>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete agent?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes <Box component="strong">{detail.agent.title}</Box>, including its
            run history, work items, and files &amp; results.
            {descendantCount ? ` Its ${descendantCount} direct and indirect report${descendantCount === 1 ? "" : "s"} will also be deleted unless promoted or reparented first.` : ""}
            {" "}This cannot be undone.
          </Typography>
          {deleteAgent.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(deleteAgent.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleteAgent.isPending}>
            Cancel
          </Button>
          <Button color="error" variant="contained" disabled={deleteAgent.isPending} onClick={() => deleteAgent.mutate()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Rename agent</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            helperText="Spaces are supported; tag multi-word names with hyphens (for example, #Grand-Teton)."
            sx={{ mt: 1 }}
          />
          {rename.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(rename.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameOpen(false)} disabled={rename.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!renameValue.trim() || rename.isPending}
            onClick={() => rename.mutate(renameValue.trim())}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={membershipOpen} onClose={() => setMembershipOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Project chat membership</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth>
              <InputLabel id="agent-memberships-label">Project chats</InputLabel>
              <Select
                labelId="agent-memberships-label"
                multiple
                value={membershipIds}
                label="Project chats"
                renderValue={(selected) => selected.map((id) => conversations.find((chat) => chat.id === id)?.title ?? id).join(", ")}
                onChange={(event) => {
                  const ids = typeof event.target.value === "string" ? event.target.value.split(",") : event.target.value;
                  setMembershipIds(ids);
                  if (!ids.includes(primaryConversationId)) setPrimaryConversationId(ids[0] ?? "");
                }}
              >
                {conversations.filter((chat) => !chat.archived || membershipIds.includes(chat.id)).map((chat) => (
                  <MenuItem key={chat.id} value={chat.id}>
                    <Checkbox checked={membershipIds.includes(chat.id)} />
                    <ListItemText primary={chat.title} secondary={chat.archived ? "Archived" : undefined} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth disabled={membershipIds.length === 0}>
              <InputLabel id="agent-primary-chat-label">Home chat</InputLabel>
              <Select labelId="agent-primary-chat-label" value={primaryConversationId} label="Home chat" onChange={(event) => setPrimaryConversationId(event.target.value)}>
                {membershipIds.map((id) => <MenuItem key={id} value={id}>{conversations.find((chat) => chat.id === id)?.title ?? id}</MenuItem>)}
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary">
              The home chat controls default routing and shared organizational context. Every membership uses this agent's single session and history.
            </Typography>
            {updateMemberships.isError ? <Alert severity="error">{String(updateMemberships.error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMembershipOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={updateMemberships.isPending || (membershipIds.length > 0 && !primaryConversationId)} onClick={() => updateMemberships.mutate()}>
            Save membership
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={organizationOpen} onClose={() => setOrganizationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Agent organization</DialogTitle>
        <DialogContent>
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel id="agent-organizational-parent-label">Reports to</InputLabel>
            <Select
              labelId="agent-organizational-parent-label"
              value={organizationParentId}
              label="Reports to"
              onChange={(event) => setOrganizationParentId(event.target.value)}
            >
              <MenuItem value="">Top level</MenuItem>
              {eligibleOrganizationParents(detail.agent, agents)
                .map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.title}</MenuItem>)}
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            This changes the agent's direct manager. Its run and message history remain attached to the same agent.
          </Typography>
          {updateOrganization.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(updateOrganization.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOrganizationOpen(false)} disabled={updateOrganization.isPending}>Cancel</Button>
          <Button variant="contained" disabled={updateOrganization.isPending} onClick={() => updateOrganization.mutate()}>
            Save organization
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
