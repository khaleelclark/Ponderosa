import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import KeyIcon from "@mui/icons-material/Key";
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
import type { AgentDto, CreateTriggerRequest, TriggerBudgetPeriod, TriggerDefinitionDto, TriggerOccurrenceDto, TriggerSourceConfig, TriggerSourceKind } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ConfirmDialog, DestructiveConfirmDialog, TextInputDialog } from "./ConfirmationDialogs";

function localFuture(minutes = 5): string {
  return isoToDatetimeLocal(new Date(Date.now() + minutes * 60_000).toISOString());
}

function isoToDatetimeLocal(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 23);
}

function changedSourceConfig(original: TriggerSourceConfig, next: TriggerSourceConfig): TriggerSourceConfig | undefined {
  return JSON.stringify(original) === JSON.stringify(next) ? undefined : next;
}

function intervalSourceConfig(everyMs: number, original?: { startsAt: string }): TriggerSourceConfig {
  return { scheduleKind: "interval", everyMs, startsAt: original?.startsAt ?? new Date().toISOString() };
}

function filesystemWindowErrors(quietValue: string, maxValue: string): { quiet?: string; max?: string } {
  const quiet = Number(quietValue);
  const max = Number(maxValue);
  const errors: { quiet?: string; max?: string } = {};
  if (!quietValue.trim() || !Number.isFinite(quiet) || quiet < 0.1 || quiet > 3_600) {
    errors.quiet = "Quiet window must be between 0.1 seconds and 1 hour.";
  }
  if (!maxValue.trim() || !Number.isFinite(max) || max < 0.1 || max > 3_600) {
    errors.max = "Maximum window must be between 0.1 seconds and 1 hour.";
  } else if (!errors.quiet && max < quiet) {
    errors.max = "Maximum window must be at least the quiet window.";
  }
  return errors;
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
  if (schedule.scheduleKind === "once") return "One-time schedule";
  if (schedule.scheduleKind === "cron") return `Cron schedule · ${schedule.timezone}`;
  return `Interval schedule · every ${Math.max(1, Math.round(schedule.everyMs / 60_000))} min`;
}

function lines(value: string): string[] {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function OccurrenceAudit({ occurrence, onOpenAgentWork }: { occurrence: TriggerOccurrenceDto; onOpenAgentWork?(occurrenceId: string): void }): JSX.Element {
  return <Box sx={{ py: 1, borderTop: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
      <Chip size="small" label={occurrence.state} color={occurrence.state === "dead_lettered" ? "error" : occurrence.state === "cancelled" ? "default" : "success"} />
      <Typography variant="caption">{new Date(occurrence.occurredAt).toLocaleString()}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{occurrence.artifactId}</Typography>
      {onOpenAgentWork ? <Button size="small" onClick={() => onOpenAgentWork(occurrence.id)}>Review Work</Button> : null}
    </Stack>
    {occurrence.lastError ? <Typography variant="caption" color="error" display="block">{occurrence.lastError}</Typography> : null}
    <Box component="details" sx={{ mt: 0.5 }}>
      <Typography component="summary" variant="caption" sx={{ cursor: "pointer" }}>Inspect payload and provenance</Typography>
      <Alert severity="warning" sx={{ mt: 1 }}>Occurrence data is untrusted and may contain sensitive external content.</Alert>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Input hash: {occurrence.inputHash}</Typography>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Definition snapshot</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.triggerSnapshot ?? {}, null, 2)}</Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Payload</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.payload, null, 2)}</Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>Provenance</Typography>
      <Box component="pre" sx={{ m: 0, p: 1, overflow: "auto", fontSize: 12, bgcolor: "action.hover" }}>{JSON.stringify(occurrence.provenance, null, 2)}</Box>
    </Box>
  </Box>;
}

export function TriggersPane({ agent, onOpenAgentWork, initialCreateOpen = false }: { agent: AgentDto; onOpenAgentWork?(occurrenceId: string): void; initialCreateOpen?: boolean }): JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.triggers.agent(agent.id);
  const triggers = useQuery({ queryKey, queryFn: () => api.listTriggers(agent.id) });
  const [createOpen, setCreateOpen] = useState(initialCreateOpen);
  const [editing, setEditing] = useState<TriggerDefinitionDto>();
  const [secret, setSecret] = useState<{ trigger: TriggerDefinitionDto; value: string }>();
  const [allowanceTrigger, setAllowanceTrigger] = useState<TriggerDefinitionDto>();
  const [rotateTrigger, setRotateTrigger] = useState<TriggerDefinitionDto>();
  const [deleteTrigger, setDeleteTrigger] = useState<TriggerDefinitionDto>();
  const [expandedId, setExpandedId] = useState<string>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [conversationId, setConversationId] = useState(agent.conversationId ?? agent.conversationIds[0] ?? "");
  const [sourceKind, setSourceKind] = useState<TriggerSourceKind>("schedule");
  const [scheduleKind, setScheduleKind] = useState<"once" | "interval" | "cron">("interval");
  const [onceAt, setOnceAt] = useState(localFuture());
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [include, setInclude] = useState("**/*");
  const [exclude, setExclude] = useState(".git/**\nnode_modules/**\n.ponderosa/**");
  const [quietSeconds, setQuietSeconds] = useState("1");
  const [maxWindowSeconds, setMaxWindowSeconds] = useState("10");
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState("10");
  const [budgetPeriod, setBudgetPeriod] = useState<TriggerBudgetPeriod>("month");
  useEffect(() => {
    if (initialCreateOpen && agent.conversationIds.length > 0) setCreateOpen(true);
  }, [agent.id, agent.conversationIds.length, initialCreateOpen]);
  const filesystemErrors = filesystemWindowErrors(quietSeconds, maxWindowSeconds);
  const sourceConfigurationInvalid = sourceKind === "filesystem" && Boolean(filesystemErrors.quiet || filesystemErrors.max);

  useEffect(() => {
    if (!agent.conversationIds.includes(conversationId)) setConversationId(agent.conversationId ?? agent.conversationIds[0] ?? "");
  }, [agent, conversationId]);

  const sourceConfig = (): CreateTriggerRequest["sourceConfig"] => {
    if (sourceKind === "webhook") {
      return editing?.sourceKind === "webhook" ? editing.sourceConfig : { replayWindowSeconds: 300 };
    }
    if (sourceKind === "filesystem") return {
      include: lines(include), exclude: lines(exclude),
      quietMs: Math.round(Number(quietSeconds) * 1_000),
      maxWindowMs: Math.round(Number(maxWindowSeconds) * 1_000),
    };
    if (scheduleKind === "once") return { scheduleKind: "once", at: new Date(onceAt).toISOString() };
    if (scheduleKind === "cron") return { scheduleKind: "cron", expression: cronExpression, timezone };
    const editingSchedule = editing?.sourceKind === "schedule"
      ? editing.sourceConfig as Extract<CreateTriggerRequest["sourceConfig"], { scheduleKind: string }>
      : undefined;
    const original = editingSchedule?.scheduleKind === "interval" ? editingSchedule : undefined;
    return intervalSourceConfig(Math.round(Number(intervalMinutes) * 60_000), original);
  };

  const resetEditor = (): void => {
    setEditing(undefined);
    setName("");
    setInstructions("");
    setConversationId(agent.conversationId ?? agent.conversationIds[0] ?? "");
    setSourceKind("schedule");
    setScheduleKind("interval");
    setOnceAt(localFuture());
    setIntervalMinutes("60");
    setBudgetEnabled(false);
    setBudgetLimit("10");
    setBudgetPeriod("month");
  };

  const openEditor = (trigger: TriggerDefinitionDto): void => {
    setEditing(trigger);
    setName(trigger.name);
    setInstructions(trigger.instructions);
    setConversationId(trigger.conversationId);
    setSourceKind(trigger.sourceKind);
    setBudgetEnabled(Boolean(trigger.runBudget));
    setBudgetLimit(String(trigger.runBudget?.limit ?? 10));
    setBudgetPeriod(trigger.runBudget?.period ?? "month");
    if (trigger.sourceKind === "schedule") {
      const config = trigger.sourceConfig as Extract<CreateTriggerRequest["sourceConfig"], { scheduleKind: string }>;
      setScheduleKind(config.scheduleKind);
      if (config.scheduleKind === "once") setOnceAt(isoToDatetimeLocal(config.at));
      else if (config.scheduleKind === "interval") setIntervalMinutes(String(config.everyMs / 60_000));
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

  const create = useMutation({
    mutationFn: async () => {
      return api.createTrigger(agent.id, { conversationId, name, instructions, sourceKind, sourceConfig: sourceConfig(), ...(budgetEnabled ? { runBudget: { limit: Number(budgetLimit), period: budgetPeriod } } : {}) });
    },
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey });
      setCreateOpen(false);
      setName("");
      setInstructions("");
      if (response.webhookSecret) setSecret({ trigger: response.trigger, value: response.webhookSecret });
    },
  });
  const saveEdit = useMutation({
    mutationFn: () => {
      const nextSourceConfig = sourceConfig();
      const changed = changedSourceConfig(editing!.sourceConfig, nextSourceConfig);
      return api.updateTrigger(editing!.id, {
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
    },
  });
  const update = useMutation({
    mutationFn: ({ trigger, enabled }: { trigger: TriggerDefinitionDto; enabled: boolean }) => api.updateTrigger(trigger.id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (trigger: TriggerDefinitionDto) => api.deleteTrigger(trigger.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      setDeleteTrigger(undefined);
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
  const occurrences = useQuery({
    queryKey: queryKeys.triggers.occurrence(expandedId),
    queryFn: () => api.listTriggerOccurrences(expandedId!, 50),
    enabled: Boolean(expandedId),
  });
  const allOccurrences = useQuery({
    queryKey: queryKeys.triggers.agentOccurrences(agent.id),
    queryFn: () => api.listAgentTriggerOccurrences(agent.id, 100),
  });
  const latestOccurrences = latestOccurrenceByTrigger(allOccurrences.data ?? []);
  const deletedTriggerOccurrences = (allOccurrences.data ?? []).filter((occurrence) => !(triggers.data ?? []).some((trigger) => trigger.id === occurrence.triggerId));

  const copy = async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
  };

  return <Box sx={{ p: { xs: 1.5, sm: 2 }, maxWidth: 960, mx: "auto" }}>
    <Stack spacing={2}>
      <Alert severity="warning">
        <strong>Triggers run automatically with this Agent&apos;s full access.</strong> External event payloads are untrusted data and stay separate from your instructions, but a Trigger can still change files, run commands, use connected tools, and contact collaborators. Use narrow instructions and accept only trusted sources.
      </Alert>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6">Triggers</Typography>
          <Typography variant="body2" color="text.secondary">Each Trigger belongs to this Agent and one of its Project chats. Work is always queued.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} disabled={agent.conversationIds.length === 0} onClick={() => { resetEditor(); setCreateOpen(true); }}>New Trigger</Button>
      </Stack>
      {agent.conversationIds.length === 0 ? <Alert severity="info">Assign this Agent to a Project chat before creating a Trigger.</Alert> : null}
      {triggers.isLoading ? <Typography color="text.secondary">Loading Triggers…</Typography> : null}
      {triggers.isError ? <Alert severity="error">{triggers.error.message}</Alert> : null}
      {(triggers.data ?? []).length === 0 && !triggers.isLoading ? <Typography color="text.secondary">No Triggers yet.</Typography> : null}
      {(triggers.data ?? []).map((trigger) => {
        const latestOccurrence = latestOccurrences.get(trigger.id);
        const currentFailure = latestOccurrence?.lastError
          ?? (latestOccurrence?.state === "dead_lettered" ? "The latest occurrence could not start." : undefined);
        const lastOccurredAt = latestOccurrence?.occurredAt ?? trigger.lastFiredAt;
        return <Card key={trigger.id} variant="outlined" aria-label={`${trigger.name} Trigger`}>
        <CardContent>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>{trigger.name}</Typography>
            <Chip size="small" label={triggerSourceSummary(trigger)} />
            <Chip size="small" color={trigger.enabled ? "success" : "default"} label={trigger.enabled ? "Enabled" : "Disabled"} />
            {trigger.runBudget && trigger.budgetState ? <Chip size="small" color={trigger.budgetState.held ? "warning" : "default"} label={`${trigger.budgetState.used}/${trigger.runBudget.limit + trigger.budgetState.allowance} automatic Runs · ${trigger.runBudget.period}`} /> : <Chip size="small" label="Unlimited Runs" />}
          </Stack>
          <Typography variant="body2" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>{trigger.instructions}</Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Source configuration: <code>{JSON.stringify(trigger.sourceConfig)}</code></Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.25, sm: 2 }} sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">Last occurrence: {lastOccurredAt ? new Date(lastOccurredAt).toLocaleString() : "None yet"}</Typography>
            {trigger.nextFireAt ? <Typography variant="caption" color="text.secondary">Next scheduled occurrence: {new Date(trigger.nextFireAt).toLocaleString()}</Typography> : null}
          </Stack>
          {currentFailure ? <Alert severity="error" sx={{ mt: 1 }}>Current failure: {currentFailure}</Alert> : null}
          {trigger.webhookPath ? <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1, overflowWrap: "anywhere" }}>Webhook: {trigger.webhookPath} · secret {trigger.secretFingerprint}</Typography> : null}
        </CardContent>
        <CardActions sx={{ flexWrap: "wrap" }}>
          <FormControlLabel control={<Switch inputProps={{ "aria-label": `${trigger.enabled ? "Disable" : "Enable"} ${trigger.name}` }} checked={trigger.enabled} disabled={update.isPending} onChange={(_, enabled) => update.mutate({ trigger, enabled })} />} label={trigger.enabled ? "Enabled" : "Disabled"} />
          <Button size="small" aria-expanded={expandedId === trigger.id} onClick={() => setExpandedId(expandedId === trigger.id ? undefined : trigger.id)}>{expandedId === trigger.id ? "Hide Full Details" : "Open Full Details"}</Button>
          <Button size="small" aria-label={`Edit ${trigger.name}`} onClick={() => openEditor(trigger)}>Edit</Button>
          {trigger.runBudget ? <Button size="small" disabled={allowRuns.isPending} onClick={() => setAllowanceTrigger(trigger)}>Allow More Runs</Button> : null}
          {trigger.sourceKind === "webhook" ? <Button size="small" startIcon={<KeyIcon />} disabled={rotate.isPending} onClick={() => setRotateTrigger(trigger)}>Rotate Secret</Button> : null}
          <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} disabled={remove.isPending} onClick={() => setDeleteTrigger(trigger)}>Delete</Button>
        </CardActions>
        <Collapse in={expandedId === trigger.id}>
          <Box sx={{ px: 2, pb: 2 }}>
            {occurrences.isLoading ? <Typography variant="body2">Loading history…</Typography> : null}
            {(occurrences.data ?? []).map((occurrence) => <OccurrenceAudit key={occurrence.id} occurrence={occurrence} onOpenAgentWork={onOpenAgentWork} />)}
            {(occurrences.data ?? []).length === 0 && !occurrences.isLoading ? <Typography variant="body2" color="text.secondary">No occurrences recorded.</Typography> : null}
          </Box>
        </Collapse>
      </Card>;
      })}
      {deletedTriggerOccurrences.length ? <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Deleted Trigger history</Typography>
          <Typography variant="body2" color="text.secondary">Immutable occurrence records remain inspectable after their Trigger is deleted.</Typography>
          {deletedTriggerOccurrences.map((occurrence) => <OccurrenceAudit key={occurrence.id} occurrence={occurrence} onOpenAgentWork={onOpenAgentWork} />)}
        </CardContent>
      </Card> : null}
    </Stack>

    <TextInputDialog
      open={Boolean(allowanceTrigger)}
      title="Allow more automatic Runs"
      label="Additional Runs"
      initialValue="5"
      helperText="Applies to the Trigger’s current budget period."
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
    <DestructiveConfirmDialog
      open={Boolean(deleteTrigger)}
      title={deleteTrigger ? `Delete “${deleteTrigger.name}”?` : "Delete Trigger?"}
      confirmLabel="Delete Trigger"
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
    </DestructiveConfirmDialog>

    <Dialog open={createOpen} onClose={() => { setCreateOpen(false); setEditing(undefined); }} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? "Edit Trigger" : "Create Trigger"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">This automation will run unattended with full Agent access. Event payloads are untrusted data.</Alert>
          <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} inputProps={{ maxLength: 120 }} autoFocus required />
          <TextField label="Trusted instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} multiline minRows={3} required helperText="Describe the action. Do not rely on event payload text as instructions." />
          <FormControl fullWidth><InputLabel id="trigger-chat-label">Project chat</InputLabel><Select disabled={Boolean(editing)} labelId="trigger-chat-label" label="Project chat" value={conversationId} onChange={(event) => setConversationId(event.target.value)}>{agent.conversationIds.map((id) => <MenuItem key={id} value={id}>{id === agent.conversationId ? `Primary · ${id}` : id}</MenuItem>)}</Select></FormControl>
          <FormControl fullWidth><InputLabel id="trigger-source-label">Source</InputLabel><Select disabled={Boolean(editing)} labelId="trigger-source-label" label="Source" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as TriggerSourceKind)}><MenuItem value="schedule">Schedule</MenuItem><MenuItem value="webhook">Signed Webhook</MenuItem><MenuItem value="filesystem">Project Folder Changes</MenuItem></Select></FormControl>
          {sourceKind === "schedule" ? <>
            <FormControl fullWidth><InputLabel id="schedule-kind-label">Schedule type</InputLabel><Select labelId="schedule-kind-label" label="Schedule type" value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}><MenuItem value="interval">Interval</MenuItem><MenuItem value="once">One Time</MenuItem><MenuItem value="cron">Cron</MenuItem></Select></FormControl>
            {scheduleKind === "interval" ? <TextField label="Every (minutes)" type="number" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} inputProps={{ min: 1 }} /> : null}
            {scheduleKind === "once" ? <TextField label="Run at" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ step: 0.001 }} /> : null}
            {scheduleKind === "cron" ? <><TextField label="Cron expression" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} helperText="Five fields; minimum frequency is once per minute." /><TextField label="IANA timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></> : null}
          </> : null}
          {sourceKind === "filesystem" ? <><TextField label="Include globs" value={include} onChange={(event) => setInclude(event.target.value)} multiline minRows={2} /><TextField label="Exclude globs" value={exclude} onChange={(event) => setExclude(event.target.value)} multiline minRows={3} /><Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField fullWidth label="Quiet window (seconds)" type="number" value={quietSeconds} onChange={(event) => setQuietSeconds(event.target.value)} inputProps={{ min: 0.1, max: 3_600, step: 0.1 }} error={Boolean(filesystemErrors.quiet)} helperText={filesystemErrors.quiet ?? "0.1 seconds–1 hour"} /><TextField fullWidth label="Maximum window (seconds)" type="number" value={maxWindowSeconds} onChange={(event) => setMaxWindowSeconds(event.target.value)} inputProps={{ min: 0.1, max: 3_600, step: 0.1 }} error={Boolean(filesystemErrors.max)} helperText={filesystemErrors.max ?? "At least quiet window; no more than 1 hour"} /></Stack><Typography variant="caption" color="text.secondary">Only paths and event types are captured; file contents are not injected.</Typography></> : null}
          {sourceKind === "webhook" ? <Typography variant="body2" color="text.secondary">Ponderosa will show a signing secret once. Send a stable event ID, Unix timestamp, and v1 HMAC-SHA256 signature with each JSON request.</Typography> : null}
          <FormControlLabel control={<Switch checked={budgetEnabled} onChange={(_, checked) => setBudgetEnabled(checked)} />} label={budgetEnabled ? "Limit automatic Runs" : "Automatic Runs are unlimited"} />
          {budgetEnabled ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField fullWidth label="Run limit" type="number" value={budgetLimit} onChange={(event) => setBudgetLimit(event.target.value)} inputProps={{ min: 1, max: 1_000_000 }} /><FormControl fullWidth><InputLabel id="trigger-budget-period-label">Reset</InputLabel><Select labelId="trigger-budget-period-label" label="Reset" value={budgetPeriod} onChange={(event) => setBudgetPeriod(event.target.value as TriggerBudgetPeriod)}><MenuItem value="day">Daily</MenuItem><MenuItem value="week">Weekly</MenuItem><MenuItem value="month">Monthly</MenuItem><MenuItem value="lifetime">Never</MenuItem></Select></FormControl></Stack> : null}
          {create.isError || saveEdit.isError ? <Alert severity="error">{(create.error ?? saveEdit.error)?.message}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => { setCreateOpen(false); setEditing(undefined); }}>Cancel</Button><Button variant="contained" disabled={create.isPending || saveEdit.isPending || !name.trim() || !instructions.trim() || !conversationId || sourceConfigurationInvalid || (budgetEnabled && (!Number.isSafeInteger(Number(budgetLimit)) || Number(budgetLimit) < 1))} onClick={() => editing ? saveEdit.mutate() : create.mutate()}>{create.isPending || saveEdit.isPending ? "Saving…" : editing ? "Save Changes" : "Create Trigger"}</Button></DialogActions>
    </Dialog>

    <Dialog open={Boolean(secret)} onClose={() => setSecret(undefined)} fullWidth maxWidth="sm">
      <DialogTitle>Save webhook secret now</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
        <Alert severity="warning">This secret is shown only once. Store it in the sending system&apos;s secret manager.</Alert>
        <TextField label="Webhook URL" value={secret ? `${window.location.origin}${secret.trigger.webhookPath}` : ""} InputProps={{ readOnly: true, endAdornment: <Button aria-label="Copy webhook URL" onClick={() => secret && copy(`${window.location.origin}${secret.trigger.webhookPath}`)}><ContentCopyIcon /></Button> }} />
        <TextField label="Signing secret" value={secret?.value ?? ""} InputProps={{ readOnly: true, endAdornment: <Button aria-label="Copy signing secret" onClick={() => secret && copy(secret.value)}><ContentCopyIcon /></Button> }} />
        <Typography variant="body2" color="text.secondary">Sign the exact raw JSON bytes as <code>timestamp.eventId.body</code>. Send <code>X-Ponderosa-Timestamp</code>, <code>X-Ponderosa-Event-Id</code>, and <code>X-Ponderosa-Signature: v1=&lt;hex&gt;</code>.</Typography>
      </Stack></DialogContent>
      <DialogActions><Button variant="contained" onClick={() => setSecret(undefined)}>I Saved It</Button></DialogActions>
    </Dialog>
  </Box>;
}
