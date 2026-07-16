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
import type { AgentDto, CreateTriggerRequest, TriggerDefinitionDto, TriggerOccurrenceDto, TriggerSourceKind } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

function localFuture(minutes = 5): string {
  const date = new Date(Date.now() + minutes * 60_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function lines(value: string): string[] {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function OccurrenceAudit({ occurrence }: { occurrence: TriggerOccurrenceDto }): JSX.Element {
  return <Box sx={{ py: 1, borderTop: 1, borderColor: "divider" }}>
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
      <Chip size="small" label={occurrence.state} color={occurrence.state === "dead_lettered" ? "error" : occurrence.state === "cancelled" ? "default" : "success"} />
      <Typography variant="caption">{new Date(occurrence.occurredAt).toLocaleString()}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{occurrence.artifactId}</Typography>
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

export function TriggersPane({ agent }: { agent: AgentDto }): JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = ["triggers", agent.id] as const;
  const triggers = useQuery({ queryKey, queryFn: () => api.listTriggers(agent.id) });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TriggerDefinitionDto>();
  const [secret, setSecret] = useState<{ trigger: TriggerDefinitionDto; value: string }>();
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

  useEffect(() => {
    if (!agent.conversationIds.includes(conversationId)) setConversationId(agent.conversationId ?? agent.conversationIds[0] ?? "");
  }, [agent, conversationId]);

  const sourceConfig = (): CreateTriggerRequest["sourceConfig"] => {
    if (sourceKind === "webhook") return { replayWindowSeconds: 300 };
    if (sourceKind === "filesystem") return {
      include: lines(include), exclude: lines(exclude),
      quietMs: Math.round(Number(quietSeconds) * 1_000),
      maxWindowMs: Math.round(Number(maxWindowSeconds) * 1_000),
    };
    if (scheduleKind === "once") return { scheduleKind: "once", at: new Date(onceAt).toISOString() };
    if (scheduleKind === "cron") return { scheduleKind: "cron", expression: cronExpression, timezone };
    return { scheduleKind: "interval", everyMs: Math.round(Number(intervalMinutes) * 60_000), startsAt: new Date().toISOString() };
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
  };

  const openEditor = (trigger: TriggerDefinitionDto): void => {
    setEditing(trigger);
    setName(trigger.name);
    setInstructions(trigger.instructions);
    setConversationId(trigger.conversationId);
    setSourceKind(trigger.sourceKind);
    if (trigger.sourceKind === "schedule") {
      const config = trigger.sourceConfig as Extract<CreateTriggerRequest["sourceConfig"], { scheduleKind: string }>;
      setScheduleKind(config.scheduleKind);
      if (config.scheduleKind === "once") setOnceAt(config.at.slice(0, 16));
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
      return api.createTrigger(agent.id, { conversationId, name, instructions, sourceKind, sourceConfig: sourceConfig() });
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
    mutationFn: () => api.updateTrigger(editing!.id, { name, instructions, sourceConfig: sourceConfig() }),
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
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
  });
  const rotate = useMutation({
    mutationFn: (trigger: TriggerDefinitionDto) => api.rotateTriggerSecret(trigger.id),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey });
      if (response.webhookSecret) setSecret({ trigger: response.trigger, value: response.webhookSecret });
    },
  });
  const occurrences = useQuery({
    queryKey: ["trigger-occurrences", expandedId],
    queryFn: () => api.listTriggerOccurrences(expandedId!, 50),
    enabled: Boolean(expandedId),
  });
  const allOccurrences = useQuery({
    queryKey: ["agent-trigger-occurrences", agent.id],
    queryFn: () => api.listAgentTriggerOccurrences(agent.id, 100),
  });
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
      {(triggers.data ?? []).map((trigger) => <Card key={trigger.id} variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>{trigger.name}</Typography>
            <Chip size="small" label={trigger.sourceKind} />
            <Chip size="small" color={trigger.enabled ? "success" : "default"} label={trigger.enabled ? "Enabled" : "Disabled"} />
          </Stack>
          <Typography variant="body2" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>{trigger.instructions}</Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Source configuration: <code>{JSON.stringify(trigger.sourceConfig)}</code></Typography>
          {trigger.nextFireAt ? <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Next: {new Date(trigger.nextFireAt).toLocaleString()}</Typography> : null}
          {trigger.webhookPath ? <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1, overflowWrap: "anywhere" }}>Webhook: {trigger.webhookPath} · secret {trigger.secretFingerprint}</Typography> : null}
        </CardContent>
        <CardActions sx={{ flexWrap: "wrap" }}>
          <FormControlLabel control={<Switch checked={trigger.enabled} disabled={update.isPending} onChange={(_, enabled) => update.mutate({ trigger, enabled })} />} label={trigger.enabled ? "On" : "Off"} />
          <Button size="small" onClick={() => setExpandedId(expandedId === trigger.id ? undefined : trigger.id)}>{expandedId === trigger.id ? "Hide history" : "History"}</Button>
          <Button size="small" onClick={() => openEditor(trigger)}>Edit</Button>
          {trigger.sourceKind === "webhook" ? <Button size="small" startIcon={<KeyIcon />} disabled={rotate.isPending} onClick={() => {
            if (window.confirm("Rotate this webhook secret? Existing senders will stop working immediately.")) rotate.mutate(trigger);
          }}>Rotate secret</Button> : null}
          <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} disabled={remove.isPending} onClick={() => {
            if (window.confirm(`Delete “${trigger.name}”? Pending occurrences will be cancelled.`)) remove.mutate(trigger);
          }}>Delete</Button>
        </CardActions>
        <Collapse in={expandedId === trigger.id}>
          <Box sx={{ px: 2, pb: 2 }}>
            {occurrences.isLoading ? <Typography variant="body2">Loading history…</Typography> : null}
            {(occurrences.data ?? []).map((occurrence) => <OccurrenceAudit key={occurrence.id} occurrence={occurrence} />)}
            {(occurrences.data ?? []).length === 0 && !occurrences.isLoading ? <Typography variant="body2" color="text.secondary">No occurrences recorded.</Typography> : null}
          </Box>
        </Collapse>
      </Card>)}
      {deletedTriggerOccurrences.length ? <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Deleted Trigger history</Typography>
          <Typography variant="body2" color="text.secondary">Immutable occurrence records remain inspectable after their Trigger is deleted.</Typography>
          {deletedTriggerOccurrences.map((occurrence) => <OccurrenceAudit key={occurrence.id} occurrence={occurrence} />)}
        </CardContent>
      </Card> : null}
    </Stack>

    <Dialog open={createOpen} onClose={() => { setCreateOpen(false); setEditing(undefined); }} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? "Edit Trigger" : "Create Trigger"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Alert severity="warning">This automation will run unattended with full Agent access. Event payloads are untrusted data.</Alert>
          <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} inputProps={{ maxLength: 120 }} autoFocus required />
          <TextField label="Trusted instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} multiline minRows={3} required helperText="Describe the action. Do not rely on event payload text as instructions." />
          <FormControl fullWidth><InputLabel id="trigger-chat-label">Project chat</InputLabel><Select disabled={Boolean(editing)} labelId="trigger-chat-label" label="Project chat" value={conversationId} onChange={(event) => setConversationId(event.target.value)}>{agent.conversationIds.map((id) => <MenuItem key={id} value={id}>{id === agent.conversationId ? `Primary · ${id}` : id}</MenuItem>)}</Select></FormControl>
          <FormControl fullWidth><InputLabel id="trigger-source-label">Source</InputLabel><Select disabled={Boolean(editing)} labelId="trigger-source-label" label="Source" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as TriggerSourceKind)}><MenuItem value="schedule">Schedule</MenuItem><MenuItem value="webhook">Signed webhook</MenuItem><MenuItem value="filesystem">Project folder changes</MenuItem></Select></FormControl>
          {sourceKind === "schedule" ? <>
            <FormControl fullWidth><InputLabel id="schedule-kind-label">Schedule type</InputLabel><Select labelId="schedule-kind-label" label="Schedule type" value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}><MenuItem value="interval">Interval</MenuItem><MenuItem value="once">One time</MenuItem><MenuItem value="cron">Cron</MenuItem></Select></FormControl>
            {scheduleKind === "interval" ? <TextField label="Every (minutes)" type="number" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} inputProps={{ min: 1 }} /> : null}
            {scheduleKind === "once" ? <TextField label="Run at" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} InputLabelProps={{ shrink: true }} /> : null}
            {scheduleKind === "cron" ? <><TextField label="Cron expression" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} helperText="Five fields; minimum frequency is once per minute." /><TextField label="IANA timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></> : null}
          </> : null}
          {sourceKind === "filesystem" ? <><TextField label="Include globs" value={include} onChange={(event) => setInclude(event.target.value)} multiline minRows={2} /><TextField label="Exclude globs" value={exclude} onChange={(event) => setExclude(event.target.value)} multiline minRows={3} /><Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField fullWidth label="Quiet window (seconds)" type="number" value={quietSeconds} onChange={(event) => setQuietSeconds(event.target.value)} /><TextField fullWidth label="Maximum window (seconds)" type="number" value={maxWindowSeconds} onChange={(event) => setMaxWindowSeconds(event.target.value)} /></Stack><Typography variant="caption" color="text.secondary">Only paths and event types are captured; file contents are not injected.</Typography></> : null}
          {sourceKind === "webhook" ? <Typography variant="body2" color="text.secondary">Ponderosa will show a signing secret once. Send a stable event ID, Unix timestamp, and v1 HMAC-SHA256 signature with each JSON request.</Typography> : null}
          {create.isError || saveEdit.isError ? <Alert severity="error">{(create.error ?? saveEdit.error)?.message}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => { setCreateOpen(false); setEditing(undefined); }}>Cancel</Button><Button variant="contained" disabled={create.isPending || saveEdit.isPending || !name.trim() || !instructions.trim() || !conversationId} onClick={() => editing ? saveEdit.mutate() : create.mutate()}>{create.isPending || saveEdit.isPending ? "Saving…" : editing ? "Save changes" : "Create Trigger"}</Button></DialogActions>
    </Dialog>

    <Dialog open={Boolean(secret)} onClose={() => setSecret(undefined)} fullWidth maxWidth="sm">
      <DialogTitle>Save webhook secret now</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
        <Alert severity="warning">This secret is shown only once. Store it in the sending system&apos;s secret manager.</Alert>
        <TextField label="Webhook URL" value={secret ? `${window.location.origin}${secret.trigger.webhookPath}` : ""} InputProps={{ readOnly: true, endAdornment: <Button aria-label="Copy webhook URL" onClick={() => secret && copy(`${window.location.origin}${secret.trigger.webhookPath}`)}><ContentCopyIcon /></Button> }} />
        <TextField label="Signing secret" value={secret?.value ?? ""} InputProps={{ readOnly: true, endAdornment: <Button aria-label="Copy signing secret" onClick={() => secret && copy(secret.value)}><ContentCopyIcon /></Button> }} />
        <Typography variant="body2" color="text.secondary">Sign the exact raw JSON bytes as <code>timestamp.eventId.body</code>. Send <code>X-Ponderosa-Timestamp</code>, <code>X-Ponderosa-Event-Id</code>, and <code>X-Ponderosa-Signature: v1=&lt;hex&gt;</code>.</Typography>
      </Stack></DialogContent>
      <DialogActions><Button variant="contained" onClick={() => setSecret(undefined)}>I saved it</Button></DialogActions>
    </Dialog>
  </Box>;
}
