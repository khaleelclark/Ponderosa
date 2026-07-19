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
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
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
  FormControlLabel,
  IconButton,
  InputLabel,
  LinearProgress,
  Link,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { AgentHealthDto, EngineCommand, EngineDto, ConversationDetailDto, ConversationDto, MessageDto, ProjectEngineCapabilitiesDto, ResponseFileActivityDto, SendMessageRequest, SendMessageResponse, AgentDetailDto, AgentDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { agentStatusColor, agentStatusLabel, deriveAgentStatus, type AgentStatus } from "../agents";
import { useAgent } from "../hooks/queries";
import { useSendMessage } from "../hooks/useSendMessage";
import { useAgentStream } from "../hooks/useAgentStream";
import { agentIdForMentionHandle } from "../mentions";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { projectedMessageIdForFocus } from "../messageFocus";
import { compactViewportQuery } from "../responsive";
import { effortOptionsForModel, effortSelectionIsCompatible, engineIsAvailable, modelSelectionIsCompatible, resolveRuntimeSelection } from "../conversationEngine";
import { ActivityPane, ArtifactsPane, ChangedFilesPane, ChatPane, Composer, QueuedMessageTray, RunsPane, WorkLogPane, WorkspaceReviewPane } from "./panes";
import { TokenUsageButton } from "./TokenUsageButton";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import { buildMarkdownTranscript, transcriptFileName } from "../chatTranscript";
import { BrowserPanel } from "./BrowserPanel";
import { conversationDisplayTitle } from "../conversationLabels";
import { TriggersPane } from "./TriggersPane";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";

type AgentTab = "chat" | "runOutput" | "activity" | "changed_files" | "review" | "runs" | "artifacts" | "triggers";

export function formatExecutionElapsed(startedAt: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function directAgentDeliveryNotice(
  response: SendMessageResponse,
  activeRunDelivery: NonNullable<SendMessageRequest["activeRunDelivery"]> = "steer",
): string | undefined {
  if (response.queued) {
    if (activeRunDelivery === "steer") return undefined;
    return `Queued in position ${response.position}; it will start when the current response finishes.`;
  }
  return response.steered ? "Steered into the active turn." : undefined;
}

function portablePackageFileName(title: string, organization: boolean, mode: "template" | "full"): string {
  const safe = title.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLocaleLowerCase().slice(0, 80);
  return `${safe || (organization ? "organization" : "agent")}-${mode === "template" ? "template" : "full"}.ponderosa.json`;
}

function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function AgentRunState({
  status,
  connected,
  startedAt,
}: {
  status: AgentStatus;
  connected: boolean;
  startedAt?: string;
}): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const runState = startedAt
    ? `${agentStatusLabel(status)} · ${formatExecutionElapsed(startedAt, now)}`
    : agentStatusLabel(status);
  const connectionState = connected ? "Live" : "Reconnecting";
  return <Chip
    size="small"
    label={`${runState} · ${connectionState}`}
    color={connected ? agentStatusColor(status) : "warning"}
    variant={connected ? "filled" : "outlined"}
    aria-label={`Agent status: ${runState}; ${connectionState.toLocaleLowerCase()}`}
  />;
}

const AGENT_DETAIL_TABS: Array<{ value: AgentTab; label: string; icon: JSX.Element }> = [
  { value: "chat", label: "Chat", icon: <ChatBubbleOutlineIcon /> },
  { value: "runOutput", label: "Work log", icon: <PsychologyOutlinedIcon /> },
  { value: "activity", label: "Activity", icon: <TimelineIcon /> },
  { value: "changed_files", label: "Changed Files", icon: <FolderCopyOutlinedIcon /> },
  { value: "review", label: "Review", icon: <DifferenceOutlinedIcon /> },
  { value: "runs", label: "Runs", icon: <TaskAltOutlinedIcon /> },
  { value: "artifacts", label: "Files & results", icon: <Inventory2OutlinedIcon /> },
  { value: "triggers", label: "Triggers", icon: <BoltOutlinedIcon /> },
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
  focusMessageId,
  engines,
  engineCapabilities,
  onRefreshCapabilities,
  projectedStatus,
  projectedHealth,
  agents,
  conversations,
  onBack,
  onOpenAgent,
  onOpenBroadcast,
  onOpenMaster,
  onNewSubagent,
  onDeleted,
}: {
  agentId: string;
  focusMessageId?: string;
  engines: EngineDto[];
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  onRefreshCapabilities(): Promise<unknown> | unknown;
  projectedStatus?: AgentStatus;
  projectedHealth?: AgentHealthDto;
  agents: AgentDto[];
  conversations: ConversationDto[];
  onBack(): void;
  onOpenAgent(agentId: string): void;
  onOpenBroadcast(conversationId: string, communicationEventId: string): void;
  onOpenMaster(conversationId: string): void;
  onNewSubagent(managerAgentId: string): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [telemetryLimit, setTelemetryLimit] = useState(100);
  const agentQuery = useAgent(agentId, telemetryLimit);
  const [olderMessages, setOlderMessages] = useState<{ messages: MessageDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stream = useAgentStream(agentId);
  const sendMessage = useSendMessage(agentId);
  const queuedMessagesQuery = useQuery({
    queryKey: ["queued-agent-messages", agentId],
    queryFn: () => api.listQueuedAgentMessages(agentId),
  });
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
  const [importOpen, setImportOpen] = useState(false);
  const [organizationParentId, setOrganizationParentId] = useState("");
  const [membershipIds, setMembershipIds] = useState<string[]>([]);
  const [primaryConversationId, setPrimaryConversationId] = useState("");
  const [queuedMessageNotice, setQueuedMessageNotice] = useState<string | undefined>();
  const [replyTo, setReplyTo] = useState<MessageDto | undefined>();
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [agentWorkOpen, setAgentWorkOpen] = useState(false);
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
  const focusedMessage = useRef<string>();
  const theme = useTheme();
  const compactViewport = useMediaQuery(compactViewportQuery(theme.breakpoints.down("sm")));
  const cancelQueuedMessage = useMutation({
    mutationFn: (deliveryId: string) => api.cancelQueuedAgentMessage(agentId, deliveryId, {
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["queued-agent-messages", agentId] }),
  });
  const editQueuedMessage = useMutation({
    mutationFn: ({ deliveryId, text }: { deliveryId: string; text: string }) => api.editQueuedAgentMessage(agentId, deliveryId, {
      text,
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["queued-agent-messages", agentId] }),
  });
  const steerQueuedMessage = useMutation({
    mutationFn: (deliveryId: string) => api.steerQueuedAgentMessage(agentId, deliveryId, {
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["queued-agent-messages", agentId] }),
  });

  useEffect(() => {
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    setTab(AGENT_DETAIL_TABS.some((item) => item.value === saved) ? saved as AgentTab : "chat");
    setOlderMessages(undefined);
    setTelemetryLimit(100);
    focusedMessage.current = undefined;
  }, [agentId]);

  useEffect(() => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), tab);
  }, [agentId, tab]);

  const detail = useMemo(() => agentQuery.data ? {
    ...agentQuery.data,
    messages: [...new Map([...(olderMessages?.messages ?? []), ...agentQuery.data.messages].map((message) => [message.id, message] as const)).values()]
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
    history: olderMessages ? {
      limit: agentQuery.data.history?.limit ?? 100,
      hasMore: olderMessages.hasMore,
      ...(olderMessages.cursor ? { cursor: olderMessages.cursor } : {}),
    } : agentQuery.data.history,
  } : undefined, [agentQuery.data, olderMessages]);

  useEffect(() => {
    if (!focusMessageId || focusedMessage.current === focusMessageId || focusedMessage.current === `missing:${focusMessageId}`) return;
    if (tab !== "chat") {
      setTab("chat");
      return;
    }
    const projectedId = projectedMessageIdForFocus(detail?.messages ?? [], focusMessageId);
    if (!projectedId) {
      if (focusedMessage.current !== `loading:${focusMessageId}`) {
        focusedMessage.current = `loading:${focusMessageId}`;
        void api.getAgent(agentId, 100, undefined, focusMessageId).then((page) => {
          setOlderMessages((current) => ({
            messages: [...new Map([...page.messages, ...(current?.messages ?? []), ...(agentQuery.data?.messages ?? [])].map((message) => [message.id, message] as const)).values()]
              .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
            cursor: page.history?.cursor,
            hasMore: page.history?.hasMore ?? false,
          }));
          focusedMessage.current = page.messages.length ? undefined : `missing:${focusMessageId}`;
        }).catch(() => { focusedMessage.current = undefined; });
      }
      return;
    }
    const target = document.getElementById(`message-${projectedId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    focusedMessage.current = focusMessageId;
  }, [agentId, detail?.messages, focusMessageId, tab]);
  const decisionsQuery = useQuery({ queryKey: ["decisions", "agent", agentId], queryFn: () => api.listDecisions({ agentId, status: "pending" }) });
  const preferencesQuery = useQuery({ queryKey: ["workspace-preferences"], queryFn: () => api.getWorkspacePreferences() });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const respondDecision = useMutation({
    mutationFn: ({ id, optionId, text }: { id: string; optionId?: string; text?: string }) => api.respondDecision(id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["decisions", "agent", agentId] });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const engine =
    engines.find((candidate) => candidate.id === detail?.agent.activeEngine) ?? engines[0];
  const project = projectsQuery.data?.find((candidate) => candidate.id === detail?.agent.projectId);
  const inheritedRuntime = resolveRuntimeSelection(engine, preferencesQuery.data, project);
  const engineCapability = engineCapabilities.find((item) => item.engineId === engine?.id);
  const commands: EngineCommand[] = [
    { name: "cancel", description: "Stop the active agent turn", source: "ponderosa", acceptsArguments: false },
    { name: "compact", description: "Compact this agent session", source: "ponderosa", acceptsArguments: false },
    { name: "status", description: "Show this agent's runtime status", source: "ponderosa", acceptsArguments: false },
    ...(engineCapability?.commands ?? []),
  ];

  const latestRun = detail?.runs.at(-1);
  const persistedModel = detail
    ? latestRun ? latestRun.model ?? inheritedRuntime.model : detail.agent.model ?? inheritedRuntime.model
    : "";
  const persistedEffort = detail
    ? latestRun ? latestRun.effort ?? inheritedRuntime.effort : detail.agent.effort ?? inheritedRuntime.effort
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

  const stopRequestId = useRef<string>();
  const cancelRun = useMutation({
    mutationFn: ({ idempotencyKey, targetRunId }: { idempotencyKey: string; targetRunId: string }) =>
      api.cancelRun(agentId, { idempotencyKey, targetRunId }),
    onSettled: () => {
      stopRequestId.current = undefined;
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    },
  });
  const recheckEngine = useMutation({
    mutationFn: (engineId: string) => api.recheckEngine(engineId),
    onSuccess: (updated) => {
      queryClient.setQueryData<EngineDto[]>(["engines"], (current) =>
        current?.map((candidate) => candidate.id === updated.id ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: ["engines"] });
    },
  });
  const stopActiveRun = () => {
    if (!runtimeActivity?.executionId) return Promise.reject(new Error("The active Run changed before it could be stopped."));
    const idempotencyKey = stopRequestId.current ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    stopRequestId.current = idempotencyKey;
    return cancelRun.mutateAsync({ idempotencyKey, targetRunId: runtimeActivity.executionId });
  };
  const copyAgentPackage = async (mode: "template" | "full", organization = false) => {
    const portable = await api.exportAgent(agentId, mode, organization);
    await navigator.clipboard.writeText(JSON.stringify(portable, null, 2));
    setQueuedMessageNotice(`${mode === "template" ? `${organization ? "Organization" : "Agent"} template` : `Full ${organization ? "organization" : "Agent"}`} copied.`);
  };
  const downloadAgentPackage = async (mode: "template" | "full", organization = false) => {
    const portable = await api.exportAgent(agentId, mode, organization);
    downloadJson(portable, portablePackageFileName(detail?.agent.title ?? "agent", organization, mode));
    setQueuedMessageNotice(`${mode === "template" ? `${organization ? "Organization" : "Agent"} template` : `Full ${organization ? "organization" : "Agent"}`} downloaded.`);
  };
  const quickCopyIntoHomeChat = async () => {
    if (!detail?.agent.conversationId) return;
    const portable = await api.exportAgent(agentId, "full", false);
    const elevated = portable.agents.some((node) =>
      node.managementPermissions.allowAutomaticDescendantDeletion ||
      node.managementPermissions.allowAutomaticDescendantReorganization);
    if (elevated && !globalThis.confirm(
      "This Agent has autonomous descendant deletion or reorganization permissions. Copy it with those elevated permissions?",
    )) return;
    const engineMapping = Object.fromEntries([...new Set(portable.agents.map((node) => node.engine))].map((engineId) => [engineId, engineId]));
    const imported = await api.importAgents(detail.agent.projectId, {
      package: portable,
      conversationId: detail.agent.conversationId,
      engineMapping,
      ...(elevated ? { acknowledgeElevatedManagementPermissions: true } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: ["agents", detail.agent.projectId] });
    onOpenAgent(imported.rootAgentId);
  };

  const rename = useMutation({
    mutationFn: (title: string) => api.updateAgent(agentId, { title }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: ["agent", agentId] }, (current) =>
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
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: ["agent", agentId] }, (current) =>
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
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: ["agent", agentId] }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["agents", updated.projectId] });
      setOrganizationOpen(false);
    },
  });

  const updateManagementPermissions = useMutation({
    mutationFn: (managementPermissions: AgentDto["managementPermissions"]) =>
      api.updateAgent(agentId, { managementPermissions }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: ["agent", agentId] }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      queryClient.setQueriesData<AgentDto[]>({ queryKey: ["agents"] }, (current) =>
        current?.map((agent) => agent.id === updated.id ? updated : agent),
      );
    },
  });

  const loadOlderMessages = async () => {
    const cursor = detail?.history?.cursor;
    if (!detail?.history?.hasMore || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.getAgent(agentId, 100, cursor);
      setOlderMessages((current) => ({
        messages: [...new Map([...page.messages, ...(current?.messages ?? []), ...(agentQuery.data?.messages ?? [])].map((message) => [message.id, message] as const)).values()]
          .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
        cursor: page.history?.cursor,
        hasMore: page.history?.hasMore ?? false,
      }));
    } finally {
      setLoadingOlder(false);
    }
  };

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
  const transcriptTitle = `${detail.agent.title} — Agent chat`;
  const transcriptMarkdown = buildMarkdownTranscript(
    transcriptTitle,
    detail.messages.map((message) => ({
      author: message.role === "user"
        ? "You"
        : message.authorAgentId
          ? agentNameForId(message.authorAgentId) ?? "Agent"
          : detail.agent.title,
      text: message.text,
      createdAt: message.createdAt,
      attachments: message.attachments,
      document: message.document,
    })),
  );
  const organizationalParent = detail.agent.managerAgentId
    ? agents.find((candidate) => candidate.id === detail.agent.managerAgentId)
    : undefined;
  const spawningAgent = detail.agent.spawnedByAgentId
    ? agents.find((candidate) => candidate.id === detail.agent.spawnedByAgentId)
    : undefined;
  const lineageAgent = spawningAgent ?? organizationalParent;
  const lineageAgentId = detail.agent.spawnedByAgentId ?? detail.agent.managerAgentId;
  const lineageLabel = detail.agent.spawnedByAgentId ? "Created by" : "Reports to";
  const agentRuntimeControls = <ComposerRuntimeSelector
    engine={engine?.id ?? ""}
    engines={engine ? [{ id: engine.id, label: engine.displayName }] : []}
    engineLocked
    model={model}
    models={models}
    effort={effort}
    efforts={efforts}
    onModelChange={(nextModel) => {
      setModel(nextModel);
      const resolved = resolveRuntimeSelection(engine, preferencesQuery.data, project, { model: nextModel });
      setEffort(resolved.effort);
    }}
    onEffortChange={setEffort}
  />;

  const submitAgentMessage = (activeRunDelivery: NonNullable<SendMessageRequest["activeRunDelivery"]>) =>
    (text: string, files: File[]) => {
      const sent = Promise.all(files.map((file) => api.uploadAttachment(agentId, file))).then(async (attachments) => {
        try {
          return await sendMessage.mutateAsync(
            {
              text,
              idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
              attachmentIds: attachments.map((item) => item.id),
              model,
              effort: effortSelectionIsCompatible(engine, model, effort) ? effort : "",
              replyToMessageId: replyTo?.id,
              activeRunDelivery,
            },
            {
              onSuccess: (response) => {
                setReplyTo(undefined);
                setQueuedMessageNotice(directAgentDeliveryNotice(response, activeRunDelivery));
                void queryClient.invalidateQueries({ queryKey: ["queued-agent-messages", agentId] });
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
    chat: <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}><Stack spacing={1} sx={{ p: (decisionsQuery.data?.length ?? 0) ? 1.5 : 0 }}>{(decisionsQuery.data ?? []).map((decision) => <Alert key={decision.id} severity={decision.blocking ? "warning" : "info"}><Typography variant="subtitle2">Decision needed</Typography><Typography variant="body2" sx={{ mb: 1 }}>{decision.question}</Typography><Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">{decision.options.map((option) => <Button key={option.id} size="small" variant="outlined" disabled={respondDecision.isPending} onClick={() => respondDecision.mutate({ id: decision.id, optionId: option.id })}>{option.label}</Button>)}{(decision.allowOther || decision.mode === "text") ? <Button size="small" variant="outlined" onClick={() => { const text = window.prompt(decision.mode === "text" ? "Your answer" : "What should the Agent do instead?"); if (text?.trim()) respondDecision.mutate({ id: decision.id, text: text.trim() }); }}>{decision.mode === "text" ? "Answer" : "Something else"}</Button> : null}</Stack></Alert>)}</Stack><ChatPane messages={detail.messages} agentName={detail.agent.title} agentNameForId={agentNameForId} agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent} onOpenWorkLog={() => setTab("runOutput")} onOpenBroadcast={(message) => onOpenBroadcast(message.conversationId!, message.communicationEventId!)} operatorProfile={preferencesQuery.data?.profile} projectId={detail.agent.projectId} previewScope={runtimeActivity?.executionId ? { projectId: detail.agent.projectId, agentId: detail.agent.id, runId: runtimeActivity.executionId } : undefined} scrollStorageKey={chatStateKey("scroll", `agent.${agentId}`)} onReact={(message, emoji) => api.sendUserReaction({
      projectId: detail.agent.projectId,
      communicationEventId: message.communicationEventId!,
      emoji,
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    })} onReply={setReplyTo} /></Box>,
    runOutput: <WorkLogPane
      entries={detail.runOutput}
      projectId={detail.agent.projectId}
      onOpenFile={(file: ResponseFileActivityDto) => {
        if (file.artifactId) {
          writeChatState(chatStateKey("view", `agent.${agentId}.artifact`), file.artifactId);
          setTab("artifacts");
        } else {
          setTab("changed_files");
        }
      }}
      onViewAll={() => setTab("review")}
    />,
    activity: <ActivityPane activity={detail.activity} connected={stream.connected} running={stream.running} activeExecutionId={runtimeActivity?.executionId} />,
    changed_files: <ChangedFilesPane files={detail.changedFiles} />,
    review: <WorkspaceReviewPane projectId={detail.agent.projectId} files={detail.changedFiles} running={stream.running} initialPath={readChatState(chatStateKey("view", `agent.${agentId}.review-file`))} />,
    runs: <RunsPane runs={detail.runs} coordinationV3={detail.coordinationV3} workItems={detail.workItems} timeline={stream.timeline} onOpenAgentWork={(runId) => { setAgentWorkFocus(runId ? `run:${runId}` : undefined); setAgentWorkOpen(true); }} />,
    artifacts: <ArtifactsPane artifacts={detail.artifacts} agentId={agentId} timeline={stream.timeline} initialArtifactId={readChatState(chatStateKey("view", `agent.${agentId}.artifact`))} />,
    triggers: <TriggersPane agent={detail.agent} onOpenAgentWork={(occurrenceId) => { setAgentWorkFocus(`trigger:${occurrenceId}`); setAgentWorkOpen(true); }} />,
  };

  return (
    <Box data-testid="agent-detail" data-agent-id={agentId} sx={{ width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto auto minmax(0, 1fr) auto" }}>
      <Box sx={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden", px: { xs: 1, sm: 1.5, md: 2 }, py: { xs: 0.75, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          sx={{ width: "100%", maxWidth: "100%", alignItems: "center", minWidth: 0, overflow: "hidden" }}
        >
          <Tooltip title="Back to agents">
            <IconButton aria-label="Back to agents" onClick={onBack} edge="start" sx={{ minWidth: 44, minHeight: 44 }}>
              <ArrowBackIcon />
            </IconButton>
          </Tooltip>
          <Box sx={{ minWidth: 0, maxWidth: "100%", width: { xs: "calc(100% - 52px)", sm: "auto" }, flex: { xs: "0 0 calc(100% - 52px)", sm: 1 }, overflow: "hidden" }}>
            <Typography variant="h6" noWrap>
              {detail.agent.title}
            </Typography>
            {lineageAgentId ? <Typography variant="caption" color="text.secondary" noWrap>
              {lineageLabel}{" "}
              {lineageAgent ? <Link component="button" variant="caption" onClick={() => onOpenAgent(lineageAgent.id)}>
                {lineageAgent.title}
              </Link> : lineageAgentId}
            </Typography> : null}
          </Box>
          <AgentRunState status={status} connected={stream.connected} startedAt={runtimeActivity?.startedAt} />
          {running ? (
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={cancelRun.isPending}
              onClick={() => stopActiveRun()}
              sx={{ minHeight: 36 }}
            >
              {cancelRun.isPending ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          <Button
            size="small"
            variant="outlined"
            startIcon={<AccountTreeOutlinedIcon />}
            onClick={() => { setAgentWorkFocus(undefined); setAgentWorkOpen(true); }}
            sx={{ minHeight: 36 }}
          >
            Agent work
          </Button>
          <ChatOverflowMenu
            label="Agent chat actions"
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            detailsLabel="Run setup"
            copyActions={[
              { label: "Agent template", onSelect: () => void copyAgentPackage("template") },
              { label: "Full Agent", onSelect: () => void copyAgentPackage("full") },
              { label: "Organization template", onSelect: () => void copyAgentPackage("template", true) },
              { label: "Full organization", onSelect: () => void copyAgentPackage("full", true) },
            ]}
            downloadActions={[
              { label: "Agent template", onSelect: () => void downloadAgentPackage("template") },
              { label: "Full Agent", onSelect: () => void downloadAgentPackage("full") },
              { label: "Organization template", onSelect: () => void downloadAgentPackage("template", true) },
              { label: "Full organization", onSelect: () => void downloadAgentPackage("full", true) },
            ]}
            details={<Stack spacing={1.25} aria-label="Agent setup">
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>Run setup</Typography>
                <TokenUsageButton scope="agent" scopeId={agentId} label={detail.agent.title} />
              </Stack>
              <Chip
                size="small"
                label={`${engine?.displayName ?? detail.agent.activeEngine}${engineIsAvailable(engine) ? "" : engine?.authenticated ? " · access unavailable" : " · not signed in"}`}
                color={engineIsAvailable(engine) ? "default" : "warning"}
                sx={{ justifyContent: "flex-start" }}
              />
              {engine?.authenticated && !engineIsAvailable(engine) ? <>
                <Typography variant="caption" color="warning.main">
                  {engine.availabilityDetail ?? "The provider rejected runtime access."}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={recheckEngine.isPending}
                  onClick={() => {
                    if (!window.confirm("Test provider access now? This sends one minimal subscription-backed request.")) return;
                    recheckEngine.mutate(engine.id);
                  }}
                >
                  {recheckEngine.isPending ? "Testing access…" : "Test access"}
                </Button>
                {recheckEngine.isError ? <Alert severity="error">{recheckEngine.error.message}</Alert> : null}
              </> : null}
              <FormControl size="small" fullWidth>
                <InputLabel id="agent-detail-model-label">Model</InputLabel>
                <Select
                  labelId="agent-detail-model-label"
                  value={models.some((option) => option.id === model) ? model : ""}
                  label="Model"
                  onChange={(event: SelectChangeEvent) => {
                    const nextModel = event.target.value;
                    setModel(nextModel);
                    if (!effortSelectionIsCompatible(engine, nextModel, effort)) setEffort("");
                  }}
                >
                  <MenuItem value="">Engine default</MenuItem>
                  {models.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel id="agent-detail-effort-label">Effort</InputLabel>
                <Select
                  labelId="agent-detail-effort-label"
                  value={efforts.some((option) => option.id === effort) ? effort : ""}
                  label="Effort"
                  onChange={(event: SelectChangeEvent) => setEffort(event.target.value)}
                >
                  <MenuItem value="">Engine default</MenuItem>
                  {efforts.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
                </Select>
              </FormControl>
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                {detail.state.branch ?? "No branch"}{detail.state.commit ? ` · ${detail.state.commit}` : ""}
              </Typography>
              <Box sx={{ pt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">Organization permissions</Typography>
                <FormControlLabel
                  control={<Switch
                    size="small"
                    checked={detail.agent.managementPermissions.allowAutomaticDescendantDeletion}
                    disabled={updateManagementPermissions.isPending}
                    onChange={(_event, checked) => updateManagementPermissions.mutate({
                      ...detail.agent.managementPermissions,
                      allowAutomaticDescendantDeletion: checked,
                    })}
                  />}
                  label={<Typography variant="body2">Allow automatic descendant deletion</Typography>}
                />
                <Typography variant="caption" color="text.secondary" display="block" sx={{ pl: 6, mt: -0.75 }}>
                  This Agent may cancel active work and permanently delete branches beneath it without another Decision.
                </Typography>
                <FormControlLabel
                  control={<Switch
                    size="small"
                    checked={detail.agent.managementPermissions.allowAutomaticDescendantReorganization}
                    disabled={updateManagementPermissions.isPending}
                    onChange={(_event, checked) => updateManagementPermissions.mutate({
                      ...detail.agent.managementPermissions,
                      allowAutomaticDescendantReorganization: checked,
                    })}
                  />}
                  label={<Typography variant="body2">Allow automatic descendant reorganization</Typography>}
                />
                <Typography variant="caption" color="text.secondary" display="block" sx={{ pl: 6, mt: -0.75 }}>
                  This Agent may rearrange reporting lines inside its subtree, but cannot detach or promote descendants.
                </Typography>
                {updateManagementPermissions.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(updateManagementPermissions.error)}</Alert> : null}
              </Box>
              <Typography variant="caption" color="text.secondary">
                {master ? <>Assigned to <Link component="button" variant="caption" onClick={() => onOpenMaster(master.id)}>{master.title}</Link></> : "Unassigned"}
                {" · "}{organizationalParent
                  ? <>Reports to <Link component="button" variant="caption" onClick={() => onOpenAgent(organizationalParent.id)}>{organizationalParent.title}</Link></>
                  : "Top level"}
              </Typography>
              <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{mcpSummary}</span>}>
                <Chip
                  size="small"
                  variant="outlined"
                  color={connectedMcps.length > 0 ? "success" : "default"}
                  label={`${connectedMcps.length}/${engineCapability?.mcpServers.length ?? 0} MCPs${engineCapability?.steering ? " · Steerable" : ""}`}
                />
              </Tooltip>
            </Stack>}
            actions={[
              {
                label: "Rename",
                icon: <DriveFileRenameOutlineIcon fontSize="small" />,
                onSelect: () => {
                  setRenameValue(detail.agent.title);
                  setRenameOpen(true);
                },
              },
              {
                label: "Create agent",
                icon: <PersonAddAlt1Icon fontSize="small" />,
                onSelect: () => onNewSubagent(agentId),
              },
              {
                label: "Assign chats",
                onSelect: () => {
                  setMembershipIds(detail.agent.conversationIds);
                  setPrimaryConversationId(detail.agent.conversationId ?? "");
                  setMembershipOpen(true);
                },
              },
              { label: "Import Agent or organization…", onSelect: () => setImportOpen(true) },
              ...(detail.agent.conversationId ? [{ label: "Quick copy into home chat", onSelect: () => void quickCopyIntoHomeChat() }] : []),
              {
                label: "Reports to",
                icon: <AccountTreeOutlinedIcon fontSize="small" />,
                onSelect: () => {
                  setOrganizationParentId(detail.agent.managerAgentId ?? "");
                  setOrganizationOpen(true);
                },
              },
              {
                label: "Delete",
                icon: <DeleteOutlineIcon fontSize="small" />,
                destructive: true,
                onSelect: () => setDeleteOpen(true),
              },
            ]}
          />
        </Stack>
        {running ? <LinearProgress aria-label="Agent is running" sx={{ mt: 1 }} /> : null}
      </Box>

      <Box sx={{ minWidth: 0 }}>
        <BrowserPanel projectId={detail.agent.projectId} agentId={agentId} runId={runtimeActivity?.executionId} />
      </Box>

      <Tabs
        aria-label="Agent details"
        value={tab}
        onChange={(_event, value: AgentTab) => setTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden", borderBottom: 1, borderColor: "divider", minHeight: 48 }}
      >
        {AGENT_DETAIL_TABS.map((item) => <Tab key={item.value} value={item.value} icon={item.icon} iconPosition="start" label={item.label} sx={{ minHeight: 48, minWidth: { xs: "auto", sm: 112 }, px: { xs: 1.25, sm: 2 } }} />)}
      </Tabs>

      <Box role="tabpanel" aria-label={`${tab === "changed_files" ? "Changed files" : tab[0]!.toUpperCase() + tab.slice(1)} panel`} tabIndex={0} sx={{ minHeight: 0, minWidth: 0, overflow: tab === "chat" ? "hidden" : "auto", outlineOffset: -2, display: "grid", gridTemplateRows: (tab === "chat" ? detail.history?.hasMore : detail.telemetryHistory?.hasMore) ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
        {tab === "chat" && detail.history?.hasMore ? <Button size="small" color="inherit" disabled={loadingOlder} onClick={() => void loadOlderMessages()} sx={{ justifySelf: "center", my: .5 }}>{loadingOlder ? "Loading…" : "Load older history"}</Button> : null}
        {tab !== "chat" && detail.telemetryHistory?.hasMore ? <Button size="small" color="inherit" onClick={() => setTelemetryLimit((current) => current + 100)} sx={{ justifySelf: "center", my: .5 }}>Load older records</Button> : null}
        {panes[tab]}
      </Box>

      {tab === "chat" ? <Box sx={{ minWidth: 0 }}>
        {queuedMessageNotice ? <Alert severity="info" role="status" aria-live="polite" sx={{ mx: 1.5, mt: 1 }}>{queuedMessageNotice}</Alert> : null}
        {sendMessage.isError || cancelRun.isError ? (
          <Alert severity="error" sx={{ mx: 1.5, mt: 1 }}>
            {sendMessage.isError ? "Message not sent." : "The agent could not be stopped."}{" "}
            {String((sendMessage.error ?? cancelRun.error) as Error)}
          </Alert>
        ) : null}
        <QueuedMessageTray
          messages={queuedMessagesQuery.data ?? []}
          busy={cancelQueuedMessage.isPending || editQueuedMessage.isPending || steerQueuedMessage.isPending}
          onSteer={(message) => steerQueuedMessage.mutateAsync(message.deliveryId)}
          onEdit={(message, text) => editQueuedMessage.mutateAsync({ deliveryId: message.deliveryId, text })}
          onDelete={(message) => cancelQueuedMessage.mutateAsync(message.deliveryId)}
        />
        <Composer
          commands={commands}
          capabilities={engineIsAvailable(engine) ? engineCapability?.composerCapabilities : []}
          onCapabilitiesOpen={onRefreshCapabilities}
          projectId={detail.agent.projectId}
          draftStorageKey={chatStateKey("draft", `agent.${agentId}`)}
          conversationDraftId={`agent:${agentId}`}
          controls={agentRuntimeControls}
          disabled={sendMessage.isPending}
          running={false}
          guidance={runtimeActivity
            ? "Send steers the active response. Choose Queue to deliver the draft after it finishes. Use @ to reference a project file."
            : "Message this agent directly. Use @ to reference a project file."}
          placeholder={runtimeActivity ? "Steer this agent's active response" : "Message this agent directly"}
          agentResponding={Boolean(runtimeActivity)}
          onSend={(text, files) => {
            if (files.length === 0 && text === "/cancel") {
              setQueuedMessageNotice("Cancelling the active turn…");
              return stopActiveRun().then(() => setQueuedMessageNotice("Active turn cancelled."));
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
          preferQueue={(queuedMessagesQuery.data?.length ?? 0) > 0}
          onCancel={() => stopActiveRun()}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(undefined)}
        />
      </Box> : null}

      <AgentDeletionDialog
        open={deleteOpen}
        projectId={detail.agent.projectId}
        rootAgentIds={[detail.agent.id]}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          setDeleteOpen(false);
          onDeleted();
        }}
      />

      <ImportAgentDialog
        open={importOpen}
        projectId={detail.agent.projectId}
        engines={engines}
        conversations={conversations}
        initialConversationId={detail.agent.conversationId}
        onClose={() => setImportOpen(false)}
        onImported={onOpenAgent}
      />

      <AgentWorkInspector
        open={agentWorkOpen}
        projectId={detail.agent.projectId}
        agentId={detail.agent.id}
        focus={agentWorkFocus ? { id: agentWorkFocus } : undefined}
        onClose={() => setAgentWorkOpen(false)}
      />

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
                renderValue={(selected) => selected.map((id) => {
                  const chat = conversations.find((candidate) => candidate.id === id);
                  return chat ? conversationDisplayTitle(chat, conversations) : id;
                }).join(", ")}
                onChange={(event) => {
                  const ids = typeof event.target.value === "string" ? event.target.value.split(",") : event.target.value;
                  setMembershipIds(ids);
                  if (!ids.includes(primaryConversationId)) setPrimaryConversationId(ids[0] ?? "");
                }}
              >
                {conversations.filter((chat) => !chat.archived || membershipIds.includes(chat.id)).map((chat) => (
                  <MenuItem key={chat.id} value={chat.id}>
                    <Checkbox checked={membershipIds.includes(chat.id)} />
                    <ListItemText primary={conversationDisplayTitle(chat, conversations)} secondary={chat.archived ? "Archived" : undefined} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth disabled={membershipIds.length === 0}>
              <InputLabel id="agent-primary-chat-label">Home chat</InputLabel>
              <Select labelId="agent-primary-chat-label" value={primaryConversationId} label="Home chat" onChange={(event) => setPrimaryConversationId(event.target.value)}>
                {membershipIds.map((id) => {
                  const chat = conversations.find((candidate) => candidate.id === id);
                  return <MenuItem key={id} value={id}>{chat ? conversationDisplayTitle(chat, conversations) : id}</MenuItem>;
                })}
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
