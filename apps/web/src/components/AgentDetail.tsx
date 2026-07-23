import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import TimelineIcon from "@mui/icons-material/Timeline";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import PersonAddAlt1Icon from "@mui/icons-material/PersonAddAlt1";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
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
  Paper,
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
import type { AgentHealthDto, EngineCommand, EngineDto, ConversationDetailDto, ConversationDto, MessageDto, ProjectEngineCapabilitiesDto, ResponseFileActivityDto, SendMessageRequest, SendMessageResponse, AgentDetailDto, AgentDto, AgentTelemetryPageDto, AgentTelemetryStream, HistoryWindowDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { agentStatusColor, agentStatusLabel, deriveAgentStatus, type AgentStatus } from "../agents";
import { useAgent, useNotifications } from "../hooks/queries";
import { useSendMessage } from "../hooks/useSendMessage";
import { useAgentStream } from "../hooks/useAgentStream";
import { agentIdForMentionHandle, agentMentionHandle } from "../mentions";
import { chatStateKey, readChatState, writeChatState } from "../chatState";
import { highlightFocusedMessage, projectedMessageIdForFocus } from "../messageFocus";
import { effortSelectionIsCompatible, engineIsAvailable, modelSelectionIsCompatible, resolveRuntimeSelection, runtimeControlState } from "../conversationEngine";
import { ActivityPane } from "./activity/ActivityPane";
import { ArtifactsPane } from "./filePreview/ArtifactsPane";
import { ChatPane } from "./chat/ChatPane";
import { Composer } from "./chat/Composer";
import { QueuedMessageTray } from "./chat/QueuedMessageTray";
import { ChatOverflowMenu } from "./ChatOverflowMenu";
import { buildMarkdownTranscript, transcriptFileName } from "../chatTranscript";
import { BrowserPanel } from "./BrowserPanel";
import { conversationDisplayTitle } from "../conversationLabels";
import { AttentionSurface } from "./AttentionSurface";
import type { AgentDetailView, AgentTelemetryFocus } from "../routing";
import { telemetryElementId } from "../telemetryFocus";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { AgentDeletionDialog } from "./AgentDeletionDialog";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { useMobileComposerAutoHide } from "../mobileChat";
import { TriggersPane } from "./TriggersPane";
import { AgentHeaderRelationships, orderedAgentHeaderChats } from "./HeaderRelationshipLinks";
import { notificationTechnicalFocusId } from "../technicalFocus";
import { queryKeys } from "../queryKeys";
import { useRuntimeControls } from "../hooks/useRuntimeControls";
import { ConfirmDialog } from "./ConfirmationDialogs";

type AgentTab = AgentDetailView;

const telemetryTab = (stream: AgentTelemetryStream): AgentTab =>
  stream === "artifacts" || stream === "changedFiles" ? "artifacts"
    : stream === "runs" || stream === "workItems" ? "technical" : "activity";

type TelemetryPageState = {
  [K in AgentTelemetryStream]?: {
    items: AgentDetailDto[K extends "runOutput" ? "runOutput"
      : K extends "activity" ? "activity"
        : K extends "changedFiles" ? "changedFiles"
        : K extends "runs" ? "runs"
          : K extends "workItems" ? "workItems" : "artifacts"];
    history?: HistoryWindowDto;
  };
};

function mergeTelemetryPage(current: TelemetryPageState, page: AgentTelemetryPageDto, preserveHistory = false): TelemetryPageState {
  const next = { ...current };
  const history = preserveHistory ? current[page.stream]?.history : page.history;
  if (page.stream === "runOutput") next.runOutput = {
    items: [...new Map([...page.items, ...(current.runOutput?.items ?? [])].map((item) => [item.id, item] as const)).values()],
    history,
  };
  else if (page.stream === "activity") next.activity = {
    items: [...new Map([...page.items, ...(current.activity?.items ?? [])].map((item) => [item.id, item] as const)).values()],
    history,
  };
  else if (page.stream === "changedFiles") next.changedFiles = {
    items: [...new Map([...page.items, ...(current.changedFiles?.items ?? [])].map((item) => [item.path, item] as const)).values()],
    history,
  };
  else if (page.stream === "runs") next.runs = {
    items: [...new Map([...page.items, ...(current.runs?.items ?? [])].map((item) => [item.id, item] as const)).values()],
    history,
  };
  else if (page.stream === "workItems") next.workItems = {
    items: [...new Map([...page.items, ...(current.workItems?.items ?? [])].map((item) => [item.id, item] as const)).values()],
    history,
  };
  else next.artifacts = {
    items: [...new Map([...page.items, ...(current.artifacts?.items ?? [])].map((item) => [item.id, item] as const)).values()],
    history,
  };
  return next;
}

const telemetryStreamsForTab = (tab: AgentTab): AgentTelemetryStream[] =>
  tab === "activity" ? ["runOutput", "activity", "runs"]
    : tab === "artifacts" ? ["artifacts"] : [];

export function formatExecutionElapsed(startedAt: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function finalizedWorkDurationMs(runs: ReadonlyArray<Pick<AgentDetailDto["runs"][number], "startedAt" | "completedAt">>): number {
  return runs.reduce((total, run) => {
    if (!run.completedAt) return total;
    const startedAt = Date.parse(run.startedAt);
    const completedAt = Date.parse(run.completedAt);
    return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
      ? total + completedAt - startedAt
      : total;
  }, 0);
}

export function formatFinalizedWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ");
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
  { value: "activity", label: "Activity", icon: <TimelineIcon /> },
  { value: "triggers", label: "Triggers", icon: <BoltOutlinedIcon /> },
  { value: "artifacts", label: "Files & Results", icon: <Inventory2OutlinedIcon /> },
  { value: "settings", label: "Settings", icon: <SettingsOutlinedIcon /> },
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
  focusTelemetry,
  technicalFocusId,
  initialView,
  createTrigger,
  onViewChange,
  onOpenTechnicalDetails,
  engines,
  engineCapabilities,
  onRefreshCapabilities,
  projectedStatus,
  projectedHealth,
  agents,
  conversations,
  onOpenProject,
  onOpenAgent,
  onOpenBroadcast,
  onOpenMaster,
  onOpenArtifact,
  onOpenArtifactInNewTab,
  onOpenReview,
  onOpenReviewInNewTab,
  onOpenBrowser,
  onNewSubagent,
  onDeleted,
}: {
  agentId: string;
  focusMessageId?: string;
  focusTelemetry?: AgentTelemetryFocus;
  technicalFocusId?: string;
  initialView?: AgentDetailView;
  createTrigger?: boolean;
  onViewChange?(view: AgentDetailView): void;
  onOpenTechnicalDetails(focusId?: string): void;
  engines: EngineDto[];
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  onRefreshCapabilities(context?: { engineId?: string; model?: string; agentId?: string }): Promise<unknown> | unknown;
  projectedStatus?: AgentStatus;
  projectedHealth?: AgentHealthDto;
  agents: AgentDto[];
  conversations: ConversationDto[];
  onOpenProject(): void;
  onOpenAgent(agentId: string): void;
  onOpenBroadcast(conversationId: string, communicationEventId: string): void;
  onOpenMaster(conversationId: string): void;
  onOpenArtifact(artifactId: string): void;
  onOpenArtifactInNewTab(artifactId: string): void;
  onOpenReview(path?: string): void;
  onOpenReviewInNewTab(path?: string): void;
  onOpenBrowser(runId: string): void;
  onNewSubagent(managerAgentId: string): void;
  onDeleted(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const agentQuery = useAgent(agentId, 100);
  const notificationsQuery = useNotifications();
  const [olderMessages, setOlderMessages] = useState<{ messages: MessageDto[]; cursor?: string; hasMore: boolean }>();
  const [olderTelemetry, setOlderTelemetry] = useState<TelemetryPageState>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const focusedTelemetryRef = useRef<string>();
  const stream = useAgentStream(agentId);
  const sendMessage = useSendMessage(agentId);
  const queuedMessagesQuery = useQuery({
    queryKey: ["queued-agent-messages", agentId],
    queryFn: () => api.listQueuedAgentMessages(agentId),
  });
  const [tab, setTab] = useState<AgentTab>(() => {
    if (initialView) return initialView;
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    return AGENT_DETAIL_TABS.some((item) => item.value === saved) || saved === "technical" ? saved as AgentTab : "chat";
  });
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [settingsEngine, setSettingsEngine] = useState("");
  const [settingsModel, setSettingsModel] = useState("");
  const [settingsEffort, setSettingsEffort] = useState("");
  const [runtimeSettingsNotice, setRuntimeSettingsNotice] = useState<string>();
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
  const [mentionInsertRequest, setMentionInsertRequest] = useState<{ id: string; text: string }>();
  const [agentWorkFocus, setAgentWorkFocus] = useState<string>();
  const [elevatedCopyPackage, setElevatedCopyPackage] = useState<Awaited<ReturnType<typeof api.exportAgent>>>();
  const [recheckEngineOpen, setRecheckEngineOpen] = useState(false);
  const focusedMessage = useRef<string>();
  const theme = useTheme();
  const mobileViewport = useMediaQuery(theme.breakpoints.down("sm"));
  const [mobileHeaderCollapsed, setMobileHeaderCollapsed] = useState(false);
  const mobileComposer = useMobileComposerAutoHide(mobileViewport);
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
    setMobileHeaderCollapsed(false);
    mobileComposer.reset();
    if (initialView) {
      setTab(initialView);
      return;
    }
    const saved = readChatState(chatStateKey("view", `agent.${agentId}`));
    setTab(AGENT_DETAIL_TABS.some((item) => item.value === saved) || saved === "technical" ? saved as AgentTab : "chat");
    setOlderMessages(undefined);
    setOlderTelemetry({});
    focusedMessage.current = undefined;
    focusedTelemetryRef.current = undefined;
  }, [agentId, initialView]);

  useEffect(() => {
    setAgentWorkFocus(technicalFocusId);
  }, [agentId, technicalFocusId]);

  useEffect(() => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), tab);
  }, [agentId, tab]);

  const detail = useMemo(() => {
    if (!agentQuery.data) return undefined;
    const mergeBy = <T,>(current: T[], older: T[] | undefined, id: (item: T) => string, compare: (a: T, b: T) => number): T[] =>
      [...new Map([...(older ?? []), ...current].map((item) => [id(item), item] as const)).values()].sort(compare);
    return {
      ...agentQuery.data,
      messages: [...new Map([...(olderMessages?.messages ?? []), ...agentQuery.data.messages].map((message) => [message.id, message] as const)).values()]
        .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
      runOutput: mergeBy(agentQuery.data.runOutput, olderTelemetry.runOutput?.items, (item) => item.id, (a, b) => a.seq - b.seq),
      activity: mergeBy(agentQuery.data.activity, olderTelemetry.activity?.items, (item) => item.id, (a, b) => a.seq - b.seq),
      changedFiles: mergeBy(agentQuery.data.changedFiles, olderTelemetry.changedFiles?.items, (item) => item.path, (a, b) => a.lastSeq - b.lastSeq),
      runs: mergeBy(agentQuery.data.runs, olderTelemetry.runs?.items, (item) => item.id, (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)),
      workItems: mergeBy(agentQuery.data.workItems, olderTelemetry.workItems?.items, (item) => item.id, (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      artifacts: mergeBy(agentQuery.data.artifacts, olderTelemetry.artifacts?.items, (item) => item.id, (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      telemetryHistory: Object.fromEntries(([
        "runOutput", "activity", "changedFiles", "runs", "workItems", "artifacts",
      ] satisfies AgentTelemetryStream[]).map((stream) => [
        stream,
        olderTelemetry[stream]?.history ?? agentQuery.data.telemetryHistory?.[stream],
      ]).filter((entry) => entry[1] !== undefined)) as AgentDetailDto["telemetryHistory"],
      history: olderMessages ? {
        limit: agentQuery.data.history?.limit ?? 100,
        hasMore: olderMessages.hasMore,
        ...(olderMessages.cursor ? { cursor: olderMessages.cursor } : {}),
      } : agentQuery.data.history,
    };
  }, [agentQuery.data, olderMessages, olderTelemetry]);

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
    highlightFocusedMessage(target);
    focusedMessage.current = focusMessageId;
  }, [agentId, detail?.messages, focusMessageId, tab]);

  useEffect(() => {
    if (!focusTelemetry) return;
    const focusedId = focusTelemetry.id;
    const focusKey = `${focusTelemetry.stream}:${focusedId}`;
    if (focusedTelemetryRef.current === focusKey || focusedTelemetryRef.current === `missing:${focusKey}`) return;
    const desiredTab = telemetryTab(focusTelemetry.stream);
    if (desiredTab === "technical") {
      setAgentWorkFocus(focusedId);
      if (tab !== "technical") setTab("technical");
      focusedTelemetryRef.current = focusKey;
      return;
    }
    if (tab !== desiredTab) {
      setTab(desiredTab);
      return;
    }
    const items = focusTelemetry.stream === "runOutput" ? detail?.runOutput
      : focusTelemetry.stream === "activity" ? detail?.activity
        : focusTelemetry.stream === "changedFiles" ? detail?.changedFiles
        : focusTelemetry.stream === "runs" ? detail?.runs
          : focusTelemetry.stream === "workItems" ? detail?.workItems
            : detail?.artifacts;
    if (!items?.some((item) => ("id" in item ? item.id : item.path) === focusedId)) {
      if (focusedTelemetryRef.current !== `loading:${focusKey}`) {
        focusedTelemetryRef.current = `loading:${focusKey}`;
        void api.getAgentHistory(agentId, focusTelemetry.stream, 100, undefined, focusTelemetry.id)
          .then((page) => {
            // A focused lookup fills a durable deep link. It must not advance the
            // ordinary history cursor past the records between recent and focused data.
            setOlderTelemetry((current) => mergeTelemetryPage(current, page, true));
            focusedTelemetryRef.current = page.items.length ? undefined : `missing:${focusKey}`;
          })
          .catch(() => { focusedTelemetryRef.current = undefined; });
      }
      return;
    }
    const target = document.getElementById(telemetryElementId(focusTelemetry.stream, focusedId));
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    focusedTelemetryRef.current = focusKey;
  }, [agentId, detail?.activity, detail?.artifacts, detail?.changedFiles, detail?.runOutput, detail?.runs, detail?.workItems, focusTelemetry, tab]);
  const preferencesQuery = useQuery({ queryKey: ["workspace-preferences"], queryFn: () => api.getWorkspacePreferences() });
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  const engine =
    engines.find((candidate) => candidate.id === detail?.agent.activeEngine) ?? engines[0];
  const project = projectsQuery.data?.find((candidate) => candidate.id === detail?.agent.projectId);
  const selectedRuntime = useRuntimeControls({
    engine,
    preferences: preferencesQuery.data,
    project,
    selection: { model, effort },
    onChange: (next) => {
      setModel(next.model);
      setEffort(next.effort);
    },
  });
  const inheritedRuntime = resolveRuntimeSelection(engine, preferencesQuery.data, project);
  const engineCapability = engineCapabilities.find((item) => item.engineId === engine?.id);
  const commands: EngineCommand[] = engineCapability?.commands ?? [];

  const persistedModel = detail
    ? detail.agent.model ?? inheritedRuntime.model
    : "";
  const persistedEffort = detail
    ? detail.agent.effort ?? inheritedRuntime.effort
    : "";

  useEffect(() => {
    setModel(persistedModel);
    setEffort(persistedEffort);
  }, [agentId, persistedModel, persistedEffort]);

  useEffect(() => {
    if (!detail) return;
    setSettingsEngine(detail.agent.activeEngine);
    setSettingsModel(detail.agent.model ?? "");
    setSettingsEffort(detail.agent.effort ?? "");
    setRuntimeSettingsNotice(undefined);
  }, [agentId, detail?.agent.activeEngine, detail?.agent.effort, detail?.agent.model]);

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
  const configuredMcps = engineCapability?.mcpServers.filter((server) => server.configured) ?? [];
  const usableMcps = configuredMcps.filter((server) => server.usable);
  const inventoriedMcps = configuredMcps.filter((server) => server.toolsDiscovered);
  const discoveredMcpTools = inventoriedMcps.reduce((total, server) => total + server.toolCount, 0);
  const mcpToolCountLabel = inventoriedMcps.length === configuredMcps.length
    ? `${discoveredMcpTools} tools`
    : `${discoveredMcpTools} tools · inventory ${inventoriedMcps.length}/${configuredMcps.length}`;
  const mcpSummary = configuredMcps.map((server) => [
    `${server.name}: ${server.initialization.replaceAll("_", " ")}`,
    server.usable ? "usable" : "not usable",
    server.toolsDiscovered ? `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}` : "tools not discovered",
    `health ${server.health}`,
    server.detail,
  ].filter(Boolean).join(" · ")).join("\n") || "No MCP servers are configured for this runtime.";

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
  const importQuickCopy = async (portable: Awaited<ReturnType<typeof api.exportAgent>>, elevated: boolean) => {
    if (!detail?.agent.conversationId) return;
    const engineMapping = Object.fromEntries([...new Set(portable.agents.map((node) => node.engine))].map((engineId) => [engineId, engineId]));
    const imported = await api.importAgents(detail.agent.projectId, {
      package: portable,
      conversationId: detail.agent.conversationId,
      engineMapping,
      ...(elevated ? { acknowledgeElevatedManagementPermissions: true } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(detail.agent.projectId) });
    setElevatedCopyPackage(undefined);
    onOpenAgent(imported.rootAgentId);
  };
  const quickCopyIntoProjectChat = async () => {
    if (!detail?.agent.conversationId) return;
    const portable = await api.exportAgent(agentId, "full", false);
    const elevated = portable.agents.some((node) =>
      node.managementPermissions.allowAutomaticDescendantDeletion ||
      node.managementPermissions.allowAutomaticDescendantReorganization);
    if (elevated) {
      setElevatedCopyPackage(portable);
      return;
    }
    await importQuickCopy(portable, false);
  };

  const rename = useMutation({
    mutationFn: (title: string) => api.updateAgent(agentId, { title }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      queryClient.setQueriesData<AgentDto[]>({ queryKey: queryKeys.agents.all }, (current) =>
        current?.map((agent) => (agent.id === updated.id ? updated : agent)),
      );
      queryClient.setQueriesData<ConversationDetailDto>({ queryKey: queryKeys.conversations.detailAll }, (current) =>
        current
          ? {
              ...current,
              agents: current.agents.map((agent) => (agent.id === updated.id ? updated : agent)),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll });
      setRenameOpen(false);
    },
  });

  const updateMemberships = useMutation({
    mutationFn: () => api.updateAgentConversationMemberships(agentId, {
      conversationIds: membershipIds,
      primaryConversationId: membershipIds.length ? primaryConversationId : undefined,
    }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll });
      setMembershipOpen(false);
    },
  });

  const updateOrganization = useMutation({
    mutationFn: () => api.updateAgentOrganization(agentId, { managerAgentId: organizationParentId || null }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(updated.projectId) });
      setOrganizationOpen(false);
    },
  });

  const updateManagementPermissions = useMutation({
    mutationFn: (managementPermissions: AgentDto["managementPermissions"]) =>
      api.updateAgent(agentId, { managementPermissions }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      queryClient.setQueriesData<AgentDto[]>({ queryKey: queryKeys.agents.all }, (current) =>
        current?.map((agent) => agent.id === updated.id ? updated : agent),
      );
    },
  });

  const updateRuntimeSettings = useMutation({
    mutationFn: () => api.updateAgent(agentId, {
      activeEngine: settingsEngine,
      model: settingsModel || null,
      effort: settingsEffort || null,
    }),
    onSuccess: (updated) => {
      queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (current) =>
        current ? { ...current, agent: updated } : current,
      );
      queryClient.setQueriesData<AgentDto[]>({ queryKey: queryKeys.agents.all }, (current) =>
        current?.map((agent) => agent.id === updated.id ? updated : agent),
      );
      queryClient.setQueriesData<ConversationDetailDto>({ queryKey: queryKeys.conversations.detailAll }, (current) =>
        current ? { ...current, agents: current.agents.map((agent) => agent.id === updated.id ? updated : agent) } : current,
      );
      setRuntimeSettingsNotice("Saved. These runtime settings apply when the next Run starts.");
    },
    onError: () => setRuntimeSettingsNotice(undefined),
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

  const loadOlderTelemetry = async () => {
    const streams = telemetryStreamsForTab(tab).filter((stream) => detail?.telemetryHistory?.[stream]?.hasMore);
    if (!detail || streams.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const pages = await Promise.all(streams.map((stream) =>
        api.getAgentHistory(agentId, stream, 100, detail.telemetryHistory?.[stream]?.cursor)));
      setOlderTelemetry((current) => pages.reduce((state, page) => mergeTelemetryPage(state, page), current));
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

  const activeTelemetryStreams = telemetryStreamsForTab(tab);
  const hasOlderTelemetry = activeTelemetryStreams.some((stream) => detail.telemetryHistory?.[stream]?.hasMore);

  const models = selectedRuntime.models;
  const efforts = selectedRuntime.efforts;
  const settingsEngineRegistration = engines.find((candidate) => candidate.id === settingsEngine);
  const settingsRuntime = runtimeControlState(settingsEngineRegistration, { model: settingsModel, effort: settingsEffort });
  const settingsModels = settingsRuntime.models;
  const settingsEfforts = settingsRuntime.efforts;
  const runtimeSettingsDirty = settingsEngine !== detail.agent.activeEngine ||
    settingsModel !== (detail.agent.model ?? "") ||
    settingsEffort !== (detail.agent.effort ?? "");
  const master = detail.agent.conversationId
    ? conversations.find((candidate) => candidate.id === detail.agent.conversationId)
    : undefined;
  const headerChats = orderedAgentHeaderChats(
    detail.agent.conversationIds,
    conversations,
    detail.agent.conversationId,
  );
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
  const lineageLabel = detail.agent.spawnedByAgentId ? "Created by" : "Delegated under";
  const agentRuntimeControls = <ComposerRuntimeSelector
    engine={engine?.id ?? ""}
    engines={engine ? [{ id: engine.id, label: engine.displayName }] : []}
    engineLocked
    model={model}
    models={models}
    effort={effort}
    efforts={efforts}
    onModelChange={(nextModel) => {
      selectedRuntime.selectModel(nextModel);
    }}
    onEffortChange={(nextEffort) => {
      selectedRuntime.selectEffort(nextEffort);
    }}
  />;

  const submitAgentMessage = (activeRunDelivery: NonNullable<SendMessageRequest["activeRunDelivery"]>) =>
    (text: string, files: File[], draftAttachmentIds: string[] = [], draftOwnerId?: string) => {
      const sent = (draftAttachmentIds.length ? Promise.resolve([]) : Promise.all(files.map((file) => api.uploadAttachment(agentId, file)))).then(async (attachments) => {
        try {
          return await sendMessage.mutateAsync(
            {
              text,
              idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
              attachmentIds: attachments.map((item) => item.id),
              ...(draftAttachmentIds.length ? { draftAttachmentIds, draftId: `agent:${agentId}`, draftOwnerId } : {}),
              model,
              effort: effortSelectionIsCompatible(engine, model, effort) ? effort : "",
              activeRunDelivery,
            },
            {
              onSuccess: (response) => {
                setQueuedMessageNotice(directAgentDeliveryNotice(response, activeRunDelivery));
                void queryClient.invalidateQueries({ queryKey: ["queued-agent-messages", agentId] });
                void queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(detail.agent.projectId) });
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

  const finalizedRunDurationLabels = new Map(detail.runs.flatMap((run) => {
    if (!run.completedAt) return [];
    const duration = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    return Number.isFinite(duration) && duration >= 0
      ? [[run.id, `Worked for ${formatFinalizedWorkDuration(duration)}`] as const]
      : [];
  }));
  const completedWorkDurationLabel = (message: MessageDto): string | undefined =>
    message.executionId ? finalizedRunDurationLabels.get(message.executionId) : undefined;
  const openTechnicalDetails = (focusId?: string) => {
    setAgentWorkFocus(focusId);
    setTab("technical");
    onOpenTechnicalDetails(focusId);
  };

  const openActivityFile = (file: ResponseFileActivityDto) => {
    if (file.artifactId) onOpenArtifact(file.artifactId);
    else onOpenReview(file.path);
  };
  const openActivityFileInNewTab = (file: ResponseFileActivityDto) => {
    if (file.artifactId) onOpenArtifactInNewTab(file.artifactId);
    else onOpenReviewInNewTab(file.path);
  };
  const settingsPane = <Stack spacing={2} aria-label="Agent settings" className="ponderosa-scroll" sx={{ p: { xs: 1.5, sm: 2.5 }, pb: 4, overflowY: "auto", minHeight: 0 }}>
    <Box>
      <Typography variant="h6">Agent Settings</Typography>
      <Typography variant="body2" color="text.secondary">Agent controls, assignments, permissions, and runtime choices for upcoming work.</Typography>
    </Box>
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={800}>Provider and next Run</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Provider, model, and reasoning are persistent Agent defaults. Changes apply when the next Run starts; steering an active Run keeps that Run&apos;s captured runtime.
      </Typography>
      <Stack spacing={1.5}>
        <FormControl size="small" fullWidth>
          <InputLabel id="agent-detail-engine-label">Provider · next Run</InputLabel>
          <Select
            labelId="agent-detail-engine-label"
            value={settingsEngine}
            label="Provider · next Run"
            onChange={(event: SelectChangeEvent) => {
              setSettingsEngine(event.target.value);
              setSettingsModel("");
              setSettingsEffort("");
              setRuntimeSettingsNotice(undefined);
            }}
          >
            {engines.map((option) => <MenuItem key={option.id} value={option.id}>{option.displayName}</MenuItem>)}
          </Select>
        </FormControl>
        <Chip
          size="small"
          label={`${settingsEngineRegistration?.displayName ?? settingsEngine}${engineIsAvailable(settingsEngineRegistration) ? "" : settingsEngineRegistration?.authenticated ? " · access unavailable" : " · not signed in"}`}
          color={engineIsAvailable(settingsEngineRegistration) ? "default" : "warning"}
          sx={{ alignSelf: "flex-start" }}
        />
        {settingsEngineRegistration?.authenticated && !engineIsAvailable(settingsEngineRegistration) ? <>
          <Typography variant="caption" color="warning.main">{settingsEngineRegistration.availabilityDetail ?? "The provider rejected runtime access."}</Typography>
          <Button size="small" variant="outlined" disabled={recheckEngine.isPending} onClick={() => setRecheckEngineOpen(true)}>{recheckEngine.isPending ? "Testing Access…" : "Test Access"}</Button>
        </> : null}
        <FormControl size="small" fullWidth>
          <InputLabel id="agent-detail-model-label">Model · next Run</InputLabel>
          <Select labelId="agent-detail-model-label" value={settingsModels.some((option) => option.id === settingsModel) ? settingsModel : ""} label="Model · next Run" onChange={(event: SelectChangeEvent) => {
            const nextModel = event.target.value;
            setSettingsModel(nextModel);
            if (!effortSelectionIsCompatible(settingsEngineRegistration, nextModel, settingsEffort)) setSettingsEffort("");
            setRuntimeSettingsNotice(undefined);
          }}>
            <MenuItem value="">Engine Default</MenuItem>
            {settingsModels.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth>
          <InputLabel id="agent-detail-effort-label">Reasoning · next Run</InputLabel>
          <Select labelId="agent-detail-effort-label" value={settingsEfforts.some((option) => option.id === settingsEffort) ? settingsEffort : ""} label="Reasoning · next Run" onChange={(event: SelectChangeEvent) => {
            setSettingsEffort(event.target.value);
            setRuntimeSettingsNotice(undefined);
          }}>
            <MenuItem value="">Engine Default</MenuItem>
            {settingsEfforts.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
          </Select>
        </FormControl>
        <Button
          size="small"
          variant="contained"
          disabled={!runtimeSettingsDirty || updateRuntimeSettings.isPending || !settingsEngine}
          onClick={() => updateRuntimeSettings.mutate()}
        >
          {updateRuntimeSettings.isPending ? "Saving…" : "Save Runtime Settings"}
        </Button>
        {runtimeSettingsNotice ? <Alert severity="success">{runtimeSettingsNotice}</Alert> : null}
        {updateRuntimeSettings.isError ? <Alert severity="error">{String(updateRuntimeSettings.error)}</Alert> : null}
        <Button size="small" variant="outlined" startIcon={<RestartAltIcon />} onClick={() => {
          setQueuedMessageNotice("Starting this Agent with a fresh provider session next time…");
          void api.compactSession(agentId)
            .then(() => setQueuedMessageNotice("Fresh provider session scheduled. Canonical history remains available."))
            .catch((error: unknown) => setQueuedMessageNotice(error instanceof Error ? error.message : "Fresh provider session could not be scheduled."));
        }}>Start Fresh Provider Session for Next Run</Button>
        <Typography variant="caption" color="text.secondary">{detail.state.branch ?? "No branch"}{detail.state.commit ? ` · ${detail.state.commit}` : ""}</Typography>
      </Stack>
    </Paper>
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={800}>Chat assignments</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {master ? <>Home chat: <Link component="button" onClick={() => onOpenMaster(master.id)}>{master.title}</Link></> : "This Agent is not assigned to a Project chat."}
      </Typography>
      <Button variant="outlined" startIcon={<ForumOutlinedIcon />} onClick={() => {
        setMembershipIds(detail.agent.conversationIds);
        setPrimaryConversationId(detail.agent.conversationId ?? "");
        setMembershipOpen(true);
      }}>Manage Chat Assignments</Button>
    </Paper>
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={800}>Organization and automatic child management</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {organizationalParent ? <>Delegated under <Link component="button" onClick={() => onOpenAgent(organizationalParent.id)}>{organizationalParent.title}</Link></> : "Top-level Agent"}
      </Typography>
      <Stack spacing={1}>
        <FormControlLabel control={<Switch size="small" checked={detail.agent.managementPermissions.allowAutomaticDescendantDeletion} disabled={updateManagementPermissions.isPending} onChange={(_event, checked) => updateManagementPermissions.mutate({ ...detail.agent.managementPermissions, allowAutomaticDescendantDeletion: checked })} />} label="Allow automatic descendant deletion" />
        <Typography variant="caption" color="text.secondary" sx={{ pl: 6 }}>May cancel active work and permanently delete descendant branches without another Decision.</Typography>
        <FormControlLabel control={<Switch size="small" checked={detail.agent.managementPermissions.allowAutomaticDescendantReorganization} disabled={updateManagementPermissions.isPending} onChange={(_event, checked) => updateManagementPermissions.mutate({ ...detail.agent.managementPermissions, allowAutomaticDescendantReorganization: checked })} />} label="Allow automatic descendant reorganization" />
        <Typography variant="caption" color="text.secondary" sx={{ pl: 6 }}>May rearrange reporting lines inside its subtree, but cannot detach or promote descendants.</Typography>
        <Button variant="outlined" startIcon={<AccountTreeOutlinedIcon />} onClick={() => {
          setOrganizationParentId(detail.agent.managerAgentId ?? "");
          setOrganizationOpen(true);
        }}>Change Reporting Line</Button>
        {updateManagementPermissions.isError ? <Alert severity="error">{String(updateManagementPermissions.error)}</Alert> : null}
      </Stack>
    </Paper>
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={800}>Runtime capabilities</Typography>
      <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{mcpSummary}</span>}>
        <Chip size="small" variant="outlined" color={usableMcps.length > 0 ? "success" : "default"} label={`${usableMcps.length}/${configuredMcps.length} MCPs · ${mcpToolCountLabel}${engineCapability?.steering ? " · Steerable" : ""}`} sx={{ mt: 1 }} />
      </Tooltip>
    </Paper>
  </Stack>;

  const panes: Record<AgentTab, JSX.Element> = {
    chat: <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}><ChatPane messages={detail.messages} agentName={detail.agent.title} agentNameForId={agentNameForId} agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent} onOpenWorkLog={() => { setTab("activity"); onViewChange?.("activity"); }} onOpenBroadcast={(message) => onOpenBroadcast(message.conversationId!, message.communicationEventId!)} operatorProfile={preferencesQuery.data?.profile} projectId={detail.agent.projectId} completedWorkDurationLabel={completedWorkDurationLabel} previewScope={runtimeActivity?.executionId ? { projectId: detail.agent.projectId, agentId: detail.agent.id, runId: runtimeActivity.executionId } : undefined} scrollStorageKey={chatStateKey("scroll", `agent.${agentId}`)} onScrollPositionChange={(element, nearBottom) => mobileComposer.observeScroll(element, nearBottom)} onMentionAgent={() => setMentionInsertRequest({ id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, text: `#${agentMentionHandle(detail.agent.title)}` })} hasOlder={detail.history?.hasMore} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlderMessages()} /></Box>,
    activity: <ActivityPane activity={detail.activity} runOutput={detail.runOutput} runs={detail.runs} connected={stream.connected} running={stream.running} activeExecutionId={runtimeActivity?.executionId} focusId={focusTelemetry?.stream === "activity" || focusTelemetry?.stream === "runOutput" ? focusTelemetry.id : undefined} projectId={detail.agent.projectId} onOpenFile={openActivityFile} onOpenFileInNewTab={openActivityFileInNewTab} onViewAll={() => onOpenReview()} />,
    triggers: <TriggersPane agent={detail.agent} initialCreateOpen={createTrigger} onOpenAgentWork={(occurrenceId) => openTechnicalDetails(`trigger:${occurrenceId}`)} />,
    artifacts: <ArtifactsPane artifacts={detail.artifacts} agentId={agentId} agentTitle={detail.agent.title} timeline={stream.timeline} initialArtifactId={focusTelemetry?.stream === "artifacts" ? focusTelemetry.id : readChatState(chatStateKey("view", `agent.${agentId}.artifact`))} onSelectArtifact={onOpenArtifact} onOpenArtifactInNewTab={onOpenArtifactInNewTab} onOpenRun={(runId) => openTechnicalDetails(`run:${runId}`)} />,
    settings: settingsPane,
    technical: <AgentWorkInspector open projectId={detail.agent.projectId} agentId={detail.agent.id} focus={agentWorkFocus ? { id: agentWorkFocus } : undefined} onClose={() => undefined} />,
  };

  return (
    <Box data-testid="agent-detail" data-agent-id={agentId} sx={{ width: "100%", maxWidth: "100%", height: "100%", maxHeight: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto auto minmax(0, 1fr) auto" }}>
      <Box className="mobile-chat-chrome mobile-chat-header" sx={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden", px: { xs: 1, sm: 1.5, md: 2 }, py: { xs: 0.5, sm: 1.25 }, borderBottom: 1, borderColor: "divider" }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          flexWrap="wrap"
          sx={{ width: "100%", maxWidth: "100%", alignItems: "center", minWidth: 0, overflow: "hidden" }}
        >
          <Box sx={{ minWidth: 0, maxWidth: "100%", flex: 1, overflow: "hidden" }}>
            <Typography variant="h6" noWrap>
              {detail.agent.title}
            </Typography>
            <AgentHeaderRelationships
              projectLabel={project?.label}
              chats={headerChats}
              onOpenProject={onOpenProject}
              onOpenChat={onOpenMaster}
            />
            {lineageAgentId ? <Typography variant="caption" color="text.secondary" noWrap>
              {lineageLabel}{" "}
              {lineageAgent ? <Link component="button" variant="caption" onClick={() => onOpenAgent(lineageAgent.id)}>
                {lineageAgent.title}
              </Link> : lineageAgentId}
            </Typography> : null}
          </Box>
          <Tooltip title={mobileHeaderCollapsed ? "Expand Agent Header" : "Minimize Agent Header"}><IconButton
            size="small"
            aria-label={mobileHeaderCollapsed ? "Expand agent header" : "Minimize agent header"}
            onClick={() => setMobileHeaderCollapsed((current) => !current)}
            sx={{ display: { xs: "inline-flex", sm: "none" }, minWidth: 36, minHeight: 36 }}
          >{mobileHeaderCollapsed ? <ExpandMoreIcon /> : <ExpandLessIcon />}</IconButton></Tooltip>
          <Collapse
            in={!mobileHeaderCollapsed || !mobileViewport}
            timeout={180}
            sx={{ flexBasis: { xs: "100%", sm: "auto" }, minWidth: 0 }}
          >
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", justifyContent: { sm: "flex-end" } }}>
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
          <ChatOverflowMenu
            label="Agent Chat Actions"
            transcriptMarkdown={transcriptMarkdown}
            transcriptFileName={transcriptFileName(transcriptTitle)}
            copyActions={[
              { label: "Agent Template", onSelect: () => void copyAgentPackage("template") },
              { label: "Full Agent", onSelect: () => void copyAgentPackage("full") },
              { label: "Organization Template", onSelect: () => void copyAgentPackage("template", true) },
              { label: "Full Organization", onSelect: () => void copyAgentPackage("full", true) },
            ]}
            downloadActions={[
              { label: "Agent Template", onSelect: () => void downloadAgentPackage("template") },
              { label: "Full Agent", onSelect: () => void downloadAgentPackage("full") },
              { label: "Organization Template", onSelect: () => void downloadAgentPackage("template", true) },
              { label: "Full Organization", onSelect: () => void downloadAgentPackage("full", true) },
            ]}
            actions={[
              {
                label: "Technical Details",
                icon: <DataObjectOutlinedIcon fontSize="small" />,
                onSelect: () => openTechnicalDetails(),
              },
              {
                label: "Rename",
                icon: <DriveFileRenameOutlineIcon fontSize="small" />,
                onSelect: () => {
                  setRenameValue(detail.agent.title);
                  setRenameOpen(true);
                },
              },
              {
                label: "Create Agent",
                icon: <PersonAddAlt1Icon fontSize="small" />,
                onSelect: () => onNewSubagent(agentId),
              },
              {
                label: "Assign Chats",
                icon: <ForumOutlinedIcon fontSize="small" />,
                onSelect: () => {
                  setMembershipIds(detail.agent.conversationIds);
                  setPrimaryConversationId(detail.agent.conversationId ?? "");
                  setMembershipOpen(true);
                },
              },
              { label: "Import Agent or Organization", icon: <FileUploadOutlinedIcon fontSize="small" />, onSelect: () => setImportOpen(true) },
              ...(detail.agent.conversationId ? [{ label: "Quick Copy into Project Chat", icon: <ContentCopyOutlinedIcon fontSize="small" />, onSelect: () => void quickCopyIntoProjectChat() }] : []),
              {
                label: "Delegated Under",
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
          </Collapse>
        </Stack>
        {running ? <Collapse in={!mobileHeaderCollapsed || !mobileViewport} timeout={180}><LinearProgress aria-label="Agent is running" sx={{ mt: 1 }} /></Collapse> : null}
      </Box>

      <Box sx={{ minWidth: 0 }}>
        <BrowserPanel projectId={detail.agent.projectId} agentId={agentId} runId={runtimeActivity?.executionId} onOpenInTab={() => runtimeActivity?.executionId && onOpenBrowser(runtimeActivity.executionId)} />
      </Box>

      <Tabs
        aria-label="Agent details"
        value={tab === "technical" ? false : tab}
        onChange={(_event, value: AgentTab) => { setTab(value); onViewChange?.(value); }}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden", borderBottom: 1, borderColor: "divider", minHeight: 48 }}
      >
        {AGENT_DETAIL_TABS.map((item) => <Tab key={item.value} value={item.value} icon={item.icon} iconPosition="start" label={item.label} sx={{ minHeight: 48, minWidth: { xs: "auto", sm: 112 }, px: { xs: 1.25, sm: 2 } }} />)}
      </Tabs>

      <Box role="tabpanel" aria-label={`${tab === "technical" ? "Technical details" : tab[0]!.toUpperCase() + tab.slice(1)} panel`} tabIndex={0} sx={{ height: "100%", maxHeight: "100%", minHeight: 0, minWidth: 0, overflow: tab === "chat" || tab === "activity" || tab === "technical" ? "hidden" : "auto", outlineOffset: -2, display: "grid", gridTemplateRows: tab === "chat" ? "auto minmax(0, 1fr)" : hasOlderTelemetry ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
        {tab === "chat" ? <AttentionSurface notifications={notificationsQuery.data ?? []} projectId={detail.agent.projectId} agentId={agentId} onOpen={(item) => {
          openTechnicalDetails(notificationTechnicalFocusId(item));
        }} /> : null}
        {tab !== "chat" && hasOlderTelemetry ? <Button size="small" color="inherit" disabled={loadingOlder} onClick={() => void loadOlderTelemetry()} sx={{ justifySelf: "center", my: .5 }}>{loadingOlder ? "Loading…" : tab === "activity" ? "Load Earlier Activity" : "Load Earlier Records"}</Button> : null}
        {panes[tab]}
      </Box>

      {tab === "chat" ? <Box
        className="mobile-chat-chrome mobile-chat-composer"
        data-mobile-composer-hidden={mobileComposer.hidden ? "true" : "false"}
        onTransitionEnd={(event) => {
          if (
            event.currentTarget === event.target
            && event.propertyName === "max-height"
          ) mobileComposer.finishTransition();
        }}
        sx={{ minWidth: 0 }}
      >
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
          onCapabilitiesOpen={() => onRefreshCapabilities({ engineId: engine?.id, model, agentId })}
          projectId={detail.agent.projectId}
          draftStorageKey={chatStateKey("draft", `agent.${agentId}`)}
          conversationDraftId={`agent:${agentId}`}
          insertTextRequest={mentionInsertRequest}
          controls={agentRuntimeControls}
          disabled={sendMessage.isPending}
          running={false}
          guidance={runtimeActivity
            ? "Send steers the active response. Choose Queue to deliver the draft after it finishes. Use @ to reference a project file."
            : "Message this agent directly. Use @ to reference a project file."}
          placeholder={runtimeActivity ? "Steer this agent's active response" : "Message this agent directly"}
          agentResponding={Boolean(runtimeActivity)}
          onSend={(text, files, stagedIds, draftOwnerId) => {
            return submitAgentMessage("steer")(text, files, stagedIds, draftOwnerId);
          }}
          onCommand={(command, argumentsText) => api.invokeProviderCommand(agentId, {
            name: command.name,
            ...(argumentsText ? { argumentsText } : {}),
          }).then((result) => setQueuedMessageNotice(result.message ?? `/${command.name} invoked through ${engine?.displayName ?? "the provider"}.`))}
          onQueue={runtimeActivity ? submitAgentMessage("queue") : undefined}
          preferQueue={(queuedMessagesQuery.data?.length ?? 0) > 0}
          onCancel={() => stopActiveRun()}
        />
      </Box> : null}

      <ConfirmDialog
        open={Boolean(elevatedCopyPackage)}
        title="Copy Elevated Agent Permissions?"
        confirmLabel="Copy Agent"
        onCancel={() => setElevatedCopyPackage(undefined)}
        onConfirm={() => {
          if (elevatedCopyPackage) void importQuickCopy(elevatedCopyPackage, true);
        }}
      >
        <Typography sx={{ pt: 1 }}>
          This Agent can automatically delete or reorganize descendants. The copied Agent will retain those elevated organization permissions.
        </Typography>
      </ConfirmDialog>

      <ConfirmDialog
        open={recheckEngineOpen}
        title="Test Provider Access?"
        confirmLabel="Test Access"
        pending={recheckEngine.isPending}
        error={recheckEngine.isError ? String(recheckEngine.error) : undefined}
        onCancel={() => {
          recheckEngine.reset();
          setRecheckEngineOpen(false);
        }}
        onConfirm={() => {
          if (!settingsEngineRegistration) return;
          recheckEngine.mutate(settingsEngineRegistration.id, {
            onSuccess: () => setRecheckEngineOpen(false),
          });
        }}
      >
        <Typography sx={{ pt: 1 }}>This sends one minimal subscription-backed request to verify that the provider is available.</Typography>
      </ConfirmDialog>

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
            Save Membership
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={organizationOpen} onClose={() => setOrganizationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Agent organization</DialogTitle>
        <DialogContent>
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel id="agent-organizational-parent-label">Delegated under</InputLabel>
            <Select
              labelId="agent-organizational-parent-label"
              value={organizationParentId}
              label="Delegated under"
              onChange={(event) => setOrganizationParentId(event.target.value)}
            >
              <MenuItem value="">Top Level</MenuItem>
              {eligibleOrganizationParents(detail.agent, agents)
                .map((candidate) => <MenuItem key={candidate.id} value={candidate.id}>{candidate.title}</MenuItem>)}
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            This changes which Agent delegates work to this Agent. Its Run and message history remain attached to the same Agent.
          </Typography>
          {updateOrganization.isError ? <Alert severity="error" sx={{ mt: 1 }}>{String(updateOrganization.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOrganizationOpen(false)} disabled={updateOrganization.isPending}>Cancel</Button>
          <Button variant="contained" disabled={updateOrganization.isPending} onClick={() => updateOrganization.mutate()}>
            Save Organization
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
