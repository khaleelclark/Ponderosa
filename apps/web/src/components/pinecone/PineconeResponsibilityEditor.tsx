import { useEffect, useState } from "react";
import { Alert, Button, DialogActions, DialogContent, DialogTitle, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import type { CreateTriggerRequest, TriggerBudgetPeriod, TriggerDefinitionDto, UpdateTriggerRequest } from "@ponderosa/core";
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from "../../browserStorage";
import { TriggerSourceFields, useTriggerSourceDraft, changedSourceConfig } from "../TriggerSourceFields";
import { reviewedDefinition } from "./responsibilities";

export function PineconeResponsibilityEditor({ projectId, conversationId, agentId, initial, reviewVersion, pending, blocked, error, onSave, onClose, onReview }: {
  projectId: string; conversationId: string; agentId: string; initial?: TriggerDefinitionDto; reviewVersion: number;
  pending: boolean; blocked: boolean; error?: string;
  onSave(request: CreateTriggerRequest | UpdateTriggerRequest): Promise<boolean>; onClose(): void; onReview(): void;
}): JSX.Element {
  const key = `pinecone-responsibility-draft:${projectId}:${conversationId}:${agentId}:${initial?.id ?? "new"}`;
  // Drafts contain no grant or executable retry. A restored edit remains bound to its original review.
  const [restored] = useState(() => {
    try {
      const value = JSON.parse(readBrowserStorage("sessionStorage", key) ?? "null");
      if (!value || !["name", "instructions", "limit"].every(field => typeof value[field] === "string") || !["day", "week", "month", "lifetime"].includes(value.period)) return null;
      const config = value.sourceConfig;
      if (!config || typeof config !== "object" || Array.isArray(config)) return null;
      const valid = config.scheduleKind === "cron" ? typeof config.expression === "string" && typeof config.timezone === "string"
        : config.scheduleKind === "once" ? typeof config.at === "string" && Number.isFinite(new Date(config.at).getTime())
        : config.scheduleKind === "interval" && typeof config.everyMs === "number" && Number.isFinite(config.everyMs) && typeof config.startsAt === "string";
      if (!valid) return null;
      if (value.reviewed && (value.reviewed.id !== initial?.id || value.reviewed.projectId !== projectId || value.reviewed.conversationId !== conversationId || value.reviewed.targetAgentId !== agentId)) return null;
      return value as { name: string; instructions: string; limit: string; period: TriggerBudgetPeriod; sourceConfig: TriggerDefinitionDto["sourceConfig"]; reviewed?: TriggerDefinitionDto };
    } catch { return null; }
  });
  const [reviewed, setReviewed] = useState(restored?.reviewed ?? initial);
  useEffect(() => { if (reviewVersion > 0) setReviewed(initial); }, [reviewVersion, initial]);
  const [name, setName] = useState(restored?.name ?? initial?.name ?? "");
  const [instructions, setInstructions] = useState(restored?.instructions ?? initial?.instructions ?? "");
  const [limit, setLimit] = useState(restored?.limit ?? String(initial?.runBudget?.limit ?? 1));
  const [period, setPeriod] = useState<TriggerBudgetPeriod>(restored?.period ?? initial?.runBudget?.period ?? "day");
  const draft = useTriggerSourceDraft(restored?.sourceConfig ?? initial?.sourceConfig ?? { scheduleKind: "cron", expression: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  const [storageAvailable, setStorageAvailable] = useState(true);
  const invalid = !name.trim() || name.trim().length > 120 || !instructions.trim() || instructions.trim().length > 20_000 || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 1_000_000 ||
    (draft.scheduleKind === "interval" ? draft.intervalInvalid : draft.scheduleKind === "cron" ? Boolean(draft.cronFormatError || draft.timezoneError) : !draft.onceAt || !Number.isFinite(new Date(draft.onceAt).getTime()));
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    let sourceConfig;
    try { sourceConfig = draft.configuration("schedule", initial?.sourceConfig); } catch { return; }
    setStorageAvailable(writeBrowserStorage("sessionStorage", key, JSON.stringify({ name, instructions, limit, period, sourceConfig, reviewed })));
  }, [key, name, instructions, limit, period, draft.scheduleKind, draft.onceAt, draft.intervalValue, draft.intervalUnit, draft.cronExpression, draft.timezone, initial, reviewed]);
  const save = async () => {
    if (pending || blocked || invalid) return;
    const fields = { name: name.trim(), instructions: instructions.trim(), sourceConfig: draft.configuration("schedule", initial?.sourceConfig), runBudget: { limit: Number(limit), period } };
    const request = initial ? {
      name: fields.name, instructions: fields.instructions,
      ...(changedSourceConfig(initial.sourceConfig, fields.sourceConfig) ? { sourceConfig: fields.sourceConfig } : {}),
      ...(initial.runBudget?.limit === fields.runBudget.limit && initial.runBudget.period === fields.runBudget.period ? {} : { runBudget: fields.runBudget }),
      reviewedDefinition: reviewedDefinition(reviewed ?? initial),
    } : { ...fields, conversationId, targetAgentId: agentId, sourceKind: "schedule" as const, enabled: false };
    if (await onSave(request)) { removeBrowserStorage("sessionStorage", key); onClose(); }
  };
  return <>
    <DialogTitle id="pinecone-editor-title">{initial ? "Edit responsibility" : "Add responsibility"}</DialogTitle>
    <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      <Typography variant="body2">Destination: this Pinecone in this Chat. New responsibilities are created disabled.</Typography>
      <TextField autoFocus label="Responsibility name" value={name} onChange={event => setName(event.target.value)} />
      <TextField label="Trusted instructions" multiline minRows={3} value={instructions} onChange={event => setInstructions(event.target.value)} helperText="Name the sources to use and when to end or review this responsibility. Instructions do not make shell execution read-only." />
      <TriggerSourceFields sourceKind="schedule" draft={draft} />
      <TextField label="Automatic Run budget" type="number" inputProps={{ min: 1, max: 1_000_000, step: 1 }} value={limit} onChange={event => setLimit(event.target.value)} />
      <FormControl><InputLabel id="pinecone-budget-period">Budget period</InputLabel><Select labelId="pinecone-budget-period" label="Budget period" value={period} onChange={event => setPeriod(event.target.value as TriggerBudgetPeriod)}>{(["day", "week", "month", "lifetime"] as const).map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}</Select></FormControl>
      {!storageAvailable ? <Alert severity="warning">Device storage is unavailable. Keep this tab open to retain this draft.</Alert> : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {blocked ? <Button disabled={pending} onClick={onReview}>Reload for review</Button> : null}
      {discard ? <Alert severity="warning" action={<Button onClick={() => { removeBrowserStorage("sessionStorage", key); onClose(); }}>Discard draft</Button>}>Close without saving? Your draft can be kept for later.</Alert> : null}
    </Stack></DialogContent>
    <DialogActions sx={{ flexWrap: "wrap" }}><Button disabled={pending} onClick={onClose}>Keep draft & close</Button><Button disabled={pending} onClick={() => setDiscard(true)}>Discard…</Button><Button disabled={invalid || pending || blocked} onClick={() => void save()}>{pending ? "Saving…" : initial ? "Save changes" : "Create disabled"}</Button></DialogActions>
  </>;
}
