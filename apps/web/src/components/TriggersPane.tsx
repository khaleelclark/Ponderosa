import {OccurrenceAudit} from './TriggerOccurrenceAudit';
import {TriggerSourceFields,useTriggerSourceDraft,isoToDatetimeLocal,intervalParts,intervalSummary,changedSourceConfig} from './TriggerSourceFields';
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import KeyIcon from "@mui/icons-material/Key";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { AgentDto, ConversationDto, CreateTriggerRequest, TriggerBudgetPeriod, TriggerDefinitionDto, TriggerOccurrenceDto, TriggerSourceConfig, TriggerSourceKind } from "@ponderosa/core";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { normalizeResetPages } from "../collections";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ConfirmDialog, ResourceDeletionDialog, TextInputDialog } from "./ConfirmationDialogs";
import { CollectionPagination } from "./CollectionPrimitives";
import { LoadingState } from "./LoadingState";
import { SemanticStatus } from "./SemanticStatus";
import { useMutationNotification } from "./MutationNotifications";

function localFuture(minutes = 5): string {
  return isoToDatetimeLocal(new Date(Date.now() + minutes * 60_000).toISOString());
}

export function triggerChatLabel(
  conversationId: string,
  conversations: readonly Pick<ConversationDto, "id" | "title" | "deletedAt">[],
): string {
  const conversation = conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation || conversation.deletedAt) return "Unavailable Chat";
  return conversation.title;
}

export function triggerChatQueryLabel(
  conversationId: string,
  conversations: readonly Pick<ConversationDto, "id" | "title" | "deletedAt">[],
  state: { isLoading: boolean; isError: boolean },
): string {
  if (state.isLoading) return "Loading Chat…";
  if (state.isError) return "Chat name unavailable";
  return triggerChatLabel(conversationId, conversations);
}

export function triggerScheduleStatus(trigger: Pick<TriggerDefinitionDto, "enabled" | "sourceKind" | "nextFireAt">): string | undefined {
  if (trigger.sourceKind !== "schedule") return undefined;
  if (!trigger.enabled) return "Not scheduled while disabled";
  return trigger.nextFireAt
    ? `Next scheduled occurrence: ${new Date(trigger.nextFireAt).toLocaleString()}`
    : "Next scheduled occurrence is being calculated";
}

function latestOccurrenceByTrigger(occurrences: TriggerOccurrenceDto[]): Map<string, TriggerOccurrenceDto> {
  const latest = new Map<string, TriggerOccurrenceDto>();
  for (const occurrence of occurrences) {
    const current = latest.get(occurrence.triggerId);
    if (!current || occurrence.occurredAt.localeCompare(current.occurredAt) > 0) latest.set(occurrence.triggerId, occurrence);
  }
  return latest;
}

function triggerSourceSummary(trigger: Pick<TriggerDefinitionDto, "sourceKind" | "sourceConfig">): string {
  if (trigger.sourceKind === "webhook") return "Signed webhook";
  if (trigger.sourceKind === "filesystem") return "Project folder changes";
  const schedule = trigger.sourceConfig as Extract<TriggerSourceConfig, { scheduleKind: string }>;
  if (schedule.scheduleKind === "once") return `Once · ${new Date(schedule.at).toLocaleString()}`;
  if (schedule.scheduleKind === "cron") {
    const [minute, hour, day, month, weekday] = schedule.expression.trim().split(/\s+/u);
    const time = hour && minute && /^\d+$/u.test(hour) && /^\d+$/u.test(minute) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : undefined;
    if (day === "*" && month === "*" && weekday === "*" && time) return `Daily at ${time} · ${schedule.timezone}`;
    if (day === "*" && month === "*" && weekday === "1-5" && time) return `Weekdays at ${time} · ${schedule.timezone}`;
    if (hour === "*" && day === "*" && month === "*" && weekday === "*" && /^\*\/\d+$/u.test(minute ?? "")) return `Every ${minute!.slice(2)} minutes · ${schedule.timezone}`;
    return `Custom repeating schedule · ${schedule.timezone}`;
  }
  return `Repeats ${intervalSummary(schedule.everyMs)} · starts ${new Date(schedule.startsAt).toLocaleString()}`;
}


export function TriggersPane({
  projectId,
  agents,
  initialTargetAgentId,
  fixedTargetAgentId,
  filterTargetAgentId,
  onOpenAgentWork,
  fixedConversationId,
  initialCreateOpen = false,
  createOnly = false,
  stickyCreateActions = false,
  ownershipSelectedExternally = false,
  onCreateTrigger,
  onTriggerCreated,
  onCreateFlowComplete,
  onCancelCreate,
  selectedTriggerId,
  settingsTriggerId,
  onCloseTriggerSettings,
  onTriggerDeleted,
}: {
  projectId: string;
  agents: AgentDto[];
  initialTargetAgentId?: string;
  fixedTargetAgentId?: string;
  filterTargetAgentId?: string;
  onOpenAgentWork?(occurrenceId: string): void;
  fixedConversationId?: string;
  initialCreateOpen?: boolean;
  createOnly?: boolean;
  stickyCreateActions?: boolean;
  ownershipSelectedExternally?: boolean;
  onCreateTrigger?(): void;
  onTriggerCreated?(trigger: TriggerDefinitionDto): void;
  onCreateFlowComplete?(): void;
  onCancelCreate?(): void;
  selectedTriggerId?: string;
  settingsTriggerId?: string;
  onCloseTriggerSettings?(): void;
  onTriggerDeleted?(triggerId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const notify = useMutationNotification();
  // The Automation editor is a relationship editor, so it must not depend on
  // a surrounding workspace roster finishing first. Load the authoritative
  // Project roster here as form data; keep the prop as immediate fallback for
  // embedded surfaces that already have it.
  const targetAgentsQuery = useQuery({
    queryKey: ["automation-target-agents", projectId],
    queryFn: () => api.listAgents(projectId),
    staleTime: 5_000,
  });
  const availableAgents = targetAgentsQuery.data ?? agents;
  const initialTarget = availableAgents.find(agent => agent.id === fixedTargetAgentId)
    ?? availableAgents.find(agent => agent.id === initialTargetAgentId)
    ?? availableAgents[0];
  const preferredConversationId =
    fixedConversationId &&
    initialTarget?.conversationId === fixedConversationId
      ? fixedConversationId
      : initialTarget?.conversationId ?? "";
  const queryKey = queryKeys.triggers.project(projectId);
  const triggers = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listTriggersPage(projectId, { limit: 100, cursor: pageParam }),
    getNextPageParam: page => page.hasMore ? page.cursor : undefined,
    select: normalizeResetPages,
  });
  const triggerItems = useMemo(() => {
    const items = (triggers.data?.pages.flatMap(page => page.items) ?? []).filter(trigger => !trigger.branchId);
    return filterTargetAgentId
      ? items.filter(trigger => trigger.targetAgentId === filterTargetAgentId)
      : items;
  }, [filterTargetAgentId, triggers.data?.pages]);
  const selectedTrigger = selectedTriggerId
    ? triggerItems.find(trigger => trigger.id === selectedTriggerId)
    : undefined;
  const visibleTriggerItems = selectedTriggerId
    ? selectedTrigger ? [selectedTrigger] : []
    : triggerItems;
  const conversations = useQuery({
    queryKey: queryKeys.conversations.project(projectId),
    queryFn: () => api.listConversations(projectId),
  });
  const currentChatLabel = (id: string): string => triggerChatQueryLabel(
    id,
    conversations.data ?? [],
    { isLoading: conversations.isLoading, isError: conversations.isError },
  );
  const [createOpen, setCreateOpen] = useState(initialCreateOpen);
  const [editing, setEditing] = useState<TriggerDefinitionDto>();
  const [secret, setSecret] = useState<{ trigger: TriggerDefinitionDto; value: string }>();
  const [allowanceTrigger, setAllowanceTrigger] = useState<TriggerDefinitionDto>();
  const [rotateTrigger, setRotateTrigger] = useState<TriggerDefinitionDto>();
  const [deleteTrigger, setDeleteTrigger] = useState<TriggerDefinitionDto>();
  const [runDisabledTrigger, setRunDisabledTrigger] = useState<TriggerDefinitionDto>();
  const [expandedId, setExpandedId] = useState<string>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [conversationId, setConversationId] = useState(preferredConversationId);
  const [targetAgentId, setTargetAgentId] = useState(initialTarget?.id ?? "");
  const [sourceKind, setSourceKind] = useState<TriggerSourceKind>("schedule");
  const sourceDraft=useTriggerSourceDraft();
  const {setScheduleKind,setOnceAt,setIntervalValue,setIntervalUnit,setCronExpression,setTimezone,setInclude,setExclude,setQuietSeconds,setMaxWindowSeconds,filesystemErrors,intervalInvalid}=sourceDraft;
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState("10");
  const [budgetPeriod, setBudgetPeriod] = useState<TriggerBudgetPeriod>("month");
  useEffect(() => {
    if (initialCreateOpen) setCreateOpen(true);
  }, [initialCreateOpen, projectId]);
  useEffect(() => {
    if (!editing) {
      setConversationId(preferredConversationId);
      setTargetAgentId(initialTarget?.id ?? "");
    }
  }, [editing, fixedConversationId, initialTarget?.id, preferredConversationId, projectId]);
  const sourceConfigurationInvalid = (sourceKind === "filesystem" && Boolean(filesystemErrors.quiet || filesystemErrors.max)) || (sourceKind === "schedule" && (sourceDraft.scheduleKind === "interval" && intervalInvalid || sourceDraft.scheduleKind === "cron" && Boolean(sourceDraft.cronFormatError || sourceDraft.timezoneError)));

  const eligibleAgents = availableAgents.filter(agent => agent.conversationId === conversationId);
  useEffect(() => {
    if (editing || eligibleAgents.some(agent => agent.id === targetAgentId)) return;
    setTargetAgentId(
      eligibleAgents.find(agent => agent.id === fixedTargetAgentId)?.id
        ?? eligibleAgents[0]?.id
        ?? "",
    );
  }, [editing, eligibleAgents, fixedTargetAgentId, targetAgentId]);

  const sourceConfig=()=>sourceDraft.configuration(sourceKind,editing?.sourceConfig);

  const resetEditor = (): void => {
    setEditing(undefined);
    setName("");
    setInstructions("");
    setConversationId(preferredConversationId);
    setTargetAgentId(initialTarget?.id ?? "");
    setSourceKind("schedule");
    setScheduleKind("interval");
    setOnceAt(localFuture());
    setIntervalValue("1");
    setIntervalUnit("hours");
    setCronExpression("0 9 * * 1-5");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setInclude("**/*");
    setExclude(".git/**\nnode_modules/**\n.ponderosa/**");
    setQuietSeconds("1");
    setMaxWindowSeconds("10");
    setBudgetEnabled(false);
    setBudgetLimit("10");
    setBudgetPeriod("month");
  };

  const openEditor = (trigger: TriggerDefinitionDto): void => {
    setEditing(trigger);
    setName(trigger.name);
    setInstructions(trigger.instructions);
    setConversationId(trigger.conversationId);
    setTargetAgentId(trigger.targetAgentId ?? "");
    setSourceKind(trigger.sourceKind);
    setBudgetEnabled(Boolean(trigger.runBudget));
    setBudgetLimit(String(trigger.runBudget?.limit ?? 10));
    setBudgetPeriod(trigger.runBudget?.period ?? "month");
    if (trigger.sourceKind === "schedule") {
      const config = trigger.sourceConfig as Extract<CreateTriggerRequest["sourceConfig"], { scheduleKind: string }>;
      setScheduleKind(config.scheduleKind);
      if (config.scheduleKind === "once") setOnceAt(isoToDatetimeLocal(config.at));
      else if (config.scheduleKind === "interval") {
        const parts = intervalParts(config.everyMs);
        setIntervalValue(parts.value);
        setIntervalUnit(parts.unit);
      }
      else { setCronExpression(config.expression); setTimezone(config.timezone); }
    } else if (trigger.sourceKind === "filesystem") {
      const config = trigger.sourceConfig as { include: string[]; exclude: string[]; quietMs: number; maxWindowMs: number };
      setInclude(config.include.join("\n"));
      setExclude(config.exclude.join("\n"));
      setQuietSeconds(String(config.quietMs / 1_000));
      setMaxWindowSeconds(String(config.maxWindowMs / 1_000));
    }
    setCreateOpen(true);
  };
  useEffect(() => {
    if (!settingsTriggerId || editing?.id === settingsTriggerId) return;
    const trigger = triggerItems.find(candidate => candidate.id === settingsTriggerId);
    if (trigger) openEditor(trigger);
  }, [editing?.id, settingsTriggerId, triggerItems]);
  const inlineSettings = Boolean(
    editing && (
      editing.id === settingsTriggerId ||
      editing.id === selectedTriggerId
    ),
  );

  const create = useMutation({
    mutationFn: async () => {
      return api.createTrigger(projectId, { conversationId, targetAgentId, name, instructions, sourceKind, sourceConfig: sourceConfig(), ...(budgetEnabled ? { runBudget: { limit: Number(budgetLimit), period: budgetPeriod } } : {}) });
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey });
      setCreateOpen(false);
      setName("");
      setInstructions("");
      if (response.webhookSecret) {
        if (!createOnly) onTriggerCreated?.(response.trigger);
        setSecret({ trigger: response.trigger, value: response.webhookSecret });
      } else {
        onTriggerCreated?.(response.trigger);
        onCreateFlowComplete?.();
      }
      notify({ key: `automation-created:${response.trigger.id}`, message: "Automation created." });
    },
  });
  const saveEdit = useMutation({
    mutationFn: () => {
      const nextSourceConfig = sourceConfig();
      const changed = changedSourceConfig(editing!.sourceConfig, nextSourceConfig);
      return api.updateTrigger(editing!.id, {
        conversationId,
        targetAgentId,
        name,
        instructions,
        ...(changed ? { sourceConfig: changed } : {}),
        runBudget: budgetEnabled ? { limit: Number(budgetLimit), period: budgetPeriod } : null,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      setCreateOpen(false);
      setEditing(undefined);
      if (settingsTriggerId) onCloseTriggerSettings?.();
      notify({ key: `automation-updated:${editing?.id ?? "automation"}`, message: "Automation updated." });
    },
  });
  const update = useMutation({
    mutationFn: ({ trigger, enabled }: { trigger: TriggerDefinitionDto; enabled: boolean }) => api.updateTrigger(trigger.id, { enabled }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey });
      notify({ key: `automation-enabled:${variables.trigger.id}`, message: variables.enabled ? "Automation enabled." : "Automation disabled." });
    },
  });
  const remove = useMutation({
    mutationFn: (trigger: TriggerDefinitionDto) => api.deleteTrigger(trigger.id),
    onSuccess: (_result, trigger) => {
      void queryClient.invalidateQueries({ queryKey });
      setDeleteTrigger(undefined);
      onTriggerDeleted?.(trigger.id);
      notify({ key: "automation-deleted", message: "Automation deleted." });
    },
  });
  const rotate = useMutation({
    mutationFn: (trigger: TriggerDefinitionDto) => api.rotateTriggerSecret(trigger.id),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey });
      if (response.webhookSecret) setSecret({ trigger: response.trigger, value: response.webhookSecret });
      setRotateTrigger(undefined);
    },
  });
  const allowRuns = useMutation({
    mutationFn: ({ trigger, additionalRuns }: { trigger: TriggerDefinitionDto; additionalRuns: number }) => api.allowTriggerRuns(trigger.id, additionalRuns),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      setAllowanceTrigger(undefined);
    },
  });
  const runNow = useMutation({
    mutationFn: ({ trigger, confirmDisabled }: { trigger: TriggerDefinitionDto; confirmDisabled: boolean }) => api.runTrigger(trigger.id, confirmDisabled),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.occurrence(variables.trigger.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.projectOccurrences(projectId) });
      setRunDisabledTrigger(undefined);
    },
  });
  const occurrences = useQuery({
    queryKey: queryKeys.triggers.occurrence(expandedId),
    queryFn: () => api.listTriggerOccurrences(expandedId!, 50),
    enabled: Boolean(expandedId),
  });
  const allOccurrences = useQuery({
    queryKey: queryKeys.triggers.projectOccurrences(projectId),
    queryFn: () => api.listProjectTriggerOccurrences(projectId, 100),
  });
  const latestOccurrences = latestOccurrenceByTrigger(allOccurrences.data ?? []);
  const deletedTriggerOccurrences = (allOccurrences.data ?? []).filter((occurrence) => !(triggerItems).some((trigger) => trigger.id === occurrence.triggerId));

  const copy = async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
  };

  const closeCreateEditor = (): void => {
    setCreateOpen(false);
    setEditing(undefined);
    if (inlineSettings && settingsTriggerId) onCloseTriggerSettings?.();
    else if (!editing) (onCancelCreate ?? onCreateFlowComplete)?.();
  };
  const closeSecret = (): void => {
    if (createOnly && secret) onTriggerCreated?.(secret.trigger);
    setSecret(undefined);
    onCreateFlowComplete?.();
  };
  const editorFields = (
    <Stack spacing={2}>
      <Alert severity="warning">This automation will run unattended with full Agent access. Event payloads are untrusted data.</Alert>
      <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} inputProps={{ maxLength: 120 }} autoFocus required />
      <TextField label="Trusted instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} multiline minRows={3} required helperText="Describe the action. Do not rely on event payload text as instructions." />
      {!ownershipSelectedExternally && (!fixedConversationId ? (
        <FormControl fullWidth>
          <InputLabel id="trigger-chat-label">Destination Chat</InputLabel>
          <Select
            labelId="trigger-chat-label"
            label="Destination Chat"
            value={conversationId}
            onChange={event => setConversationId(event.target.value)}
          >
            {(conversations.data ?? []).filter(chat => !chat.deletedAt).map(chat => (
              <MenuItem key={chat.id} value={chat.id}>{chat.title}</MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : (
        <TextField label="Destination Chat" value={currentChatLabel(conversationId)} disabled />
      ))}
      {!ownershipSelectedExternally && (!fixedTargetAgentId ? (
        <FormControl fullWidth>
          <InputLabel id="trigger-target-agent-label">Runs As</InputLabel>
          <Select
            labelId="trigger-target-agent-label"
            label="Runs As"
            value={targetAgentId}
            onChange={event => setTargetAgentId(event.target.value)}
          >
            {eligibleAgents.map(agent => (
              <MenuItem key={agent.id} value={agent.id}>{agent.title}{eligibleAgents.some(other => other.id !== agent.id && other.title === agent.title) ? ` · #${agent.handle}` : ""}</MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : (
        <TextField
          label="Runs As"
          value={availableAgents.find(agent => agent.id === targetAgentId)?.title ?? "Unavailable Agent"}
          disabled
        />
      ))}
      <Typography variant="caption" color="text.secondary">
        Each occurrence is sent to the selected Chat and runs as the selected Agent.
      </Typography>
      <FormControl fullWidth><InputLabel id="trigger-source-label">Source</InputLabel><Select disabled={Boolean(editing)} labelId="trigger-source-label" label="Source" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as TriggerSourceKind)}><MenuItem value="schedule">Schedule</MenuItem><MenuItem value="webhook">Signed Webhook</MenuItem><MenuItem value="filesystem">Project Folder Changes</MenuItem></Select></FormControl>
      <TriggerSourceFields sourceKind={sourceKind} draft={sourceDraft}/>
      <FormControlLabel control={<Switch checked={budgetEnabled} onChange={(_, checked) => setBudgetEnabled(checked)} />} label={budgetEnabled ? "Limit automatic Runs" : "Automatic Runs are unlimited"} />
      {budgetEnabled ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField fullWidth label="Run limit" type="number" value={budgetLimit} onChange={(event) => setBudgetLimit(event.target.value)} inputProps={{ min: 1, max: 1_000_000 }} /><FormControl fullWidth><InputLabel id="trigger-budget-period-label">Reset</InputLabel><Select labelId="trigger-budget-period-label" label="Reset" value={budgetPeriod} onChange={(event) => setBudgetPeriod(event.target.value as TriggerBudgetPeriod)}><MenuItem value="day">Daily</MenuItem><MenuItem value="week">Weekly</MenuItem><MenuItem value="month">Monthly</MenuItem><MenuItem value="lifetime">Never</MenuItem></Select></FormControl></Stack> : null}
      {create.isError || saveEdit.isError ? <Alert severity="error">{(create.error ?? saveEdit.error)?.message}</Alert> : null}
    </Stack>
  );
  const editorActions = (
    <Stack direction="row" spacing={1} sx={{
      justifyContent: "flex-end",
      ...(createOnly && stickyCreateActions ? {
        position: "absolute",
        zIndex: 2,
        bottom: 0,
        left: 0,
        right: 0,
        px: { xs: 2, sm: 3 },
        py: 1.5,
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
      } : {}),
    }}>
      <Button onClick={closeCreateEditor}>Cancel</Button>
      <Button variant="contained" disabled={create.isPending || saveEdit.isPending || !name.trim() || !instructions.trim() || !conversationId || !targetAgentId || sourceConfigurationInvalid || (budgetEnabled && (!Number.isSafeInteger(Number(budgetLimit)) || Number(budgetLimit) < 1))} onClick={() => editing ? saveEdit.mutate() : create.mutate()}>{create.isPending || saveEdit.isPending ? "Saving…" : editing ? "Save Changes" : "Create Automation"}</Button>
    </Stack>
  );

  return <Box sx={{ p: { xs: 1.5, sm: 2 }, maxWidth: createOnly ? 760 : 960, mx: "auto" }}>
    {inlineSettings ? (
      <Stack spacing={2}>
        <Box>
          <Button
            color="inherit"
            startIcon={<ArrowBackIcon />}
            onClick={closeCreateEditor}
            sx={{ mb: 1 }}
          >
            {selectedTriggerId ? "Back to Automation" : "Back to Automations"}
          </Button>
          <Typography variant="h5" component="h2" fontWeight={800}>
            Automation Settings
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage {editing?.name} without leaving this Project.
          </Typography>
        </Box>
        {editorFields}
        {editorActions}
      </Stack>
    ) : null}
    <Stack spacing={2} sx={{ display: createOnly || inlineSettings ? "none" : undefined }}>
      {selectedTriggerId ? (
        <Box>
          <Button
            color="inherit"
            startIcon={<ArrowBackIcon />}
            onClick={onCloseTriggerSettings}
            sx={{ mb: 1 }}
          >
            Back to Automations
          </Button>
          <Typography variant="h5" component="h2" fontWeight={800}>
            Automation
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {selectedTrigger
              ? `Manage ${selectedTrigger.name}: run, enable, inspect, or edit it.`
              : "Loading Automation…"}
          </Typography>
        </Box>
      ) : (
        <>
          <Alert severity="warning">
            <strong>Automations run automatically with the selected Agent&apos;s full access.</strong> External event payloads are untrusted data and stay separate from your instructions, but an Automation can still change files, run commands, use connected tools, and contact collaborators. Use narrow instructions and accept only trusted sources.
          </Alert>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6">Automations</Typography>
              <Typography variant="body2" color="text.secondary">Automations belong to the Project. Each one sends work to a destination Chat and an execution Agent.</Typography>
            </Box>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                if (onCreateTrigger) {
                  onCreateTrigger();
                  return;
                }
                resetEditor();
                setCreateOpen(true);
              }}
            >
              New Automation
            </Button>
          </Stack>
        </>
      )}
      {triggers.isLoading ? <Typography color="text.secondary">Loading Automations…</Typography> : null}
      {triggers.isError ? <Alert severity="error">{triggers.error.message}</Alert> : null}
      {selectedTriggerId && !selectedTrigger && !triggers.isLoading && !triggers.isError ? (
        <Alert severity="warning">This Automation could not be found. It may have been deleted.</Alert>
      ) : null}
      {!selectedTriggerId && triggerItems.length === 0 && !triggers.isLoading ? <Typography color="text.secondary">No Automations yet.</Typography> : null}
      {visibleTriggerItems.map((trigger) => {
        const latestOccurrence = latestOccurrences.get(trigger.id);
        const currentFailure = latestOccurrence?.lastError
          ?? (latestOccurrence?.state === "dead_lettered" ? "The latest occurrence could not start." : undefined);
        const lastOccurredAt = latestOccurrence?.occurredAt ?? trigger.lastFiredAt;
        const scheduleStatus = triggerScheduleStatus(trigger);
        return <Card key={trigger.id} variant="outlined" aria-label={`${trigger.name} Automation`}>
        <CardContent>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>{trigger.name}</Typography>
            <Chip size="small" label={triggerSourceSummary(trigger)} />
            {trigger.enabled
              ? <Chip size="small" color="success" label="Enabled" />
              : <SemanticStatus status="disabled" />}
            {trigger.runBudget && trigger.budgetState ? <Chip size="small" color={trigger.budgetState.held ? "warning" : "default"} label={`${trigger.budgetState.used}/${trigger.runBudget.limit + trigger.budgetState.allowance} automatic Runs · ${trigger.runBudget.period}`} /> : <Chip size="small" label="Unlimited Runs" />}
          </Stack>
          <Typography variant="body2" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>{trigger.instructions}</Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Chat: {currentChatLabel(trigger.conversationId)}</Typography>
          <Typography variant="caption" color="text.secondary" display="block">Runs as: {agents.find(agent => agent.id === trigger.targetAgentId)?.title ?? "Unavailable Agent"}</Typography>
          <Box component="details" sx={{ mt: 1 }}><Typography component="summary" variant="caption">Technical details</Typography><Box component="pre" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{JSON.stringify(trigger.sourceConfig, null, 2)}</Box></Box>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.25, sm: 2 }} sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">Last occurrence: {lastOccurredAt ? new Date(lastOccurredAt).toLocaleString() : "None yet"}</Typography>
            {scheduleStatus ? <Typography variant="caption" color="text.secondary">{scheduleStatus}</Typography> : null}
          </Stack>
          {currentFailure ? <Alert severity="error" sx={{ mt: 1 }}>Current failure: {currentFailure}</Alert> : null}
          {trigger.webhookPath ? <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1, overflowWrap: "anywhere" }}>Webhook: {trigger.webhookPath} · secret {trigger.secretFingerprint}</Typography> : null}
        </CardContent>
        <CardActions sx={{ flexWrap: "wrap" }}>
          <Button
            size="small"
            startIcon={<PlayArrowIcon />}
            disabled={runNow.isPending}
            onClick={() => trigger.enabled
              ? runNow.mutate({ trigger, confirmDisabled: false })
              : setRunDisabledTrigger(trigger)}
          >{runNow.isPending && runNow.variables?.trigger.id === trigger.id ? "Starting…" : "Run Now"}</Button>
          <FormControlLabel control={<Switch inputProps={{ "aria-label": `${trigger.enabled ? "Disable" : "Enable"} ${trigger.name}` }} checked={trigger.enabled} disabled={update.isPending} onChange={(_, enabled) => update.mutate({ trigger, enabled })} />} label={trigger.enabled ? "Enabled" : "Disabled"} />
          <Button size="small" aria-expanded={expandedId === trigger.id} onClick={() => setExpandedId(expandedId === trigger.id ? undefined : trigger.id)}>{expandedId === trigger.id ? "Hide Full Details" : "Open Full Details"}</Button>
          <Button size="small" aria-label={`Edit ${trigger.name}`} onClick={() => openEditor(trigger)}>Edit</Button>
          <Button
            size="small"
            color="error"
            startIcon={<DeleteOutlineIcon />}
            disabled={remove.isPending}
            onClick={() => setDeleteTrigger(trigger)}
          >
            Delete
          </Button>
          {trigger.runBudget ? <Button size="small" disabled={allowRuns.isPending} onClick={() => setAllowanceTrigger(trigger)}>Allow More Runs</Button> : null}
          {trigger.sourceKind === "webhook" ? <Button size="small" startIcon={<KeyIcon />} disabled={rotate.isPending} onClick={() => setRotateTrigger(trigger)}>Rotate Secret</Button> : null}
        </CardActions>
        <Collapse in={expandedId === trigger.id}>
          <Box sx={{ px: 2, pb: 2 }}>
            {occurrences.isLoading ? <LoadingState resource="Automation history" variant="inline" /> : null}
            {(occurrences.data ?? []).map((occurrence) => <OccurrenceAudit key={occurrence.id} occurrence={occurrence} onOpenAgentWork={onOpenAgentWork} />)}
            {(occurrences.data ?? []).length === 0 && !occurrences.isLoading ? <Typography variant="body2" color="text.secondary">No occurrences recorded.</Typography> : null}
          </Box>
        </Collapse>
      </Card>;
      })}
      {!selectedTriggerId ? <CollectionPagination
        resourceLabel="Automations"
        request={{
          hasResolved: Boolean(triggers.data),
          isInitialLoading: triggers.isPending,
          isRefreshing: triggers.isFetching && !triggers.isFetchingNextPage,
          isInitialError: !triggers.data && triggers.isError,
          isPaginationError: Boolean(triggers.data) && triggers.isFetchNextPageError,
          isFetchingNextPage: triggers.isFetchingNextPage,
          hasNextPage: Boolean(triggers.hasNextPage),
          retry: triggers.refetch,
          fetchNextPage: triggers.fetchNextPage,
        }}
      /> : null}
      {!selectedTriggerId && deletedTriggerOccurrences.length ? <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Deleted Automation history</Typography>
          <Typography variant="body2" color="text.secondary">Immutable occurrence records remain inspectable after their Automation is deleted.</Typography>
          {deletedTriggerOccurrences.map((occurrence) => <OccurrenceAudit key={occurrence.id} occurrence={occurrence} onOpenAgentWork={onOpenAgentWork} />)}
        </CardContent>
      </Card> : null}
    </Stack>
    {createOnly ? (
      <Stack spacing={2.5}>
        {editorFields}
        {editorActions}
      </Stack>
    ) : null}

    <TextInputDialog
      open={Boolean(allowanceTrigger)}
      title="Allow more automatic Runs"
      label="Additional Runs"
      initialValue="5"
      helperText="Applies to the Automation’s current budget period."
      confirmLabel="Allow Runs"
      pendingLabel="Saving…"
      pending={allowRuns.isPending}
      error={allowRuns.isError ? allowRuns.error.message : undefined}
      validate={(value) => Number.isSafeInteger(Number(value)) && Number(value) >= 1 ? undefined : "Enter a positive whole number."}
      onCancel={() => {
        allowRuns.reset();
        setAllowanceTrigger(undefined);
      }}
      onConfirm={(value) => {
        if (allowanceTrigger) allowRuns.mutate({ trigger: allowanceTrigger, additionalRuns: Number(value) });
      }}
    />
    <ConfirmDialog
      open={Boolean(runDisabledTrigger)}
      title="Run this disabled Automation once?"
      confirmLabel="Run Once"
      pendingLabel="Starting…"
      pending={runNow.isPending}
      error={runNow.isError ? runNow.error.message : undefined}
      onCancel={() => {
        runNow.reset();
        setRunDisabledTrigger(undefined);
      }}
      onConfirm={() => {
        if (runDisabledTrigger) runNow.mutate({ trigger: runDisabledTrigger, confirmDisabled: true });
      }}
    >
      <Typography sx={{ pt: 1 }}>This starts one operator-requested Run without enabling future automatic occurrences or consuming the automatic Run budget.</Typography>
    </ConfirmDialog>
    <ConfirmDialog
      open={Boolean(rotateTrigger)}
      title="Rotate this webhook secret?"
      confirmLabel="Rotate Secret"
      pendingLabel="Rotating…"
      pending={rotate.isPending}
      error={rotate.isError ? rotate.error.message : undefined}
      onCancel={() => {
        rotate.reset();
        setRotateTrigger(undefined);
      }}
      onConfirm={() => {
        if (rotateTrigger) rotate.mutate(rotateTrigger);
      }}
    >
      <Typography sx={{ pt: 1 }}>Existing senders will stop working immediately.</Typography>
    </ConfirmDialog>
    <ResourceDeletionDialog
      open={Boolean(deleteTrigger)}
      resourceType="Automation"
      resourceName={deleteTrigger?.name}
      pendingLabel="Deleting…"
      pending={remove.isPending}
      error={remove.isError ? remove.error.message : undefined}
      onCancel={() => {
        remove.reset();
        setDeleteTrigger(undefined);
      }}
      onConfirm={() => {
        if (deleteTrigger) remove.mutate(deleteTrigger);
      }}
    >
      <Typography sx={{ pt: 1 }}>Pending occurrences will be cancelled. Immutable occurrence history remains available.</Typography>
    </ResourceDeletionDialog>

    <Dialog open={!createOnly && createOpen && !inlineSettings} onClose={closeCreateEditor} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? "Edit Automation" : "Create Automation"}</DialogTitle>
      <DialogContent>
        <Box sx={{ pt: 1 }}>{editorFields}</Box>
      </DialogContent>
      <DialogActions>{editorActions}</DialogActions>
    </Dialog>

    <Dialog open={Boolean(secret)} onClose={closeSecret} fullWidth maxWidth="sm">
      <DialogTitle>Save webhook secret now</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
        <Alert severity="warning">This secret is shown only once. Store it in the sending system&apos;s secret manager.</Alert>
        <TextField label="Webhook URL" value={secret ? `${window.location.origin}${secret.trigger.webhookPath}` : ""} InputProps={{ readOnly: true, endAdornment: <Button aria-label="Copy webhook URL" onClick={() => secret && copy(`${window.location.origin}${secret.trigger.webhookPath}`)}><ContentCopyIcon /></Button> }} />
        <TextField label="Signing secret" value={secret?.value ?? ""} InputProps={{ readOnly: true, endAdornment: <Button aria-label="Copy signing secret" onClick={() => secret && copy(secret.value)}><ContentCopyIcon /></Button> }} />
        <Typography variant="body2" color="text.secondary">Sign the exact raw JSON bytes as <code>timestamp.eventId.body</code>. Send <code>X-Ponderosa-Timestamp</code>, <code>X-Ponderosa-Event-Id</code>, and <code>X-Ponderosa-Signature: v1=&lt;hex&gt;</code>.</Typography>
      </Stack></DialogContent>
      <DialogActions><Button variant="contained" onClick={closeSecret}>I Saved It</Button></DialogActions>
    </Dialog>
  </Box>;
}
