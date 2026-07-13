import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Checkbox, FormControlLabel, List, ListItem, ListItemText,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { AgentPresetDto, EngineDto, ConversationDto, ThreadDto } from "@ponderosa/core";
import { useEffect, useState } from "react";

const UNSET = "";

export interface CreateConversationInput {
  title: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export function PresetManagerDialog({ open, engines, presets, onClose, onSave, onDelete }: {
  open: boolean; engines: EngineDto[]; presets: AgentPresetDto[]; onClose(): void;
  onSave(id: string | undefined, input: { name: string; description: string; guidance: string; engine: string; model?: string; effort?: string; enabled: boolean }): void;
  onDelete(id: string): void;
}): JSX.Element {
  const [editing, setEditing] = useState<AgentPresetDto | undefined>();
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [guidance, setGuidance] = useState("");
  const [engine, setEngine] = useState(""); const [model, setModel] = useState(""); const [effort, setEffort] = useState(""); const [enabled, setEnabled] = useState(true);
  const edit = (preset?: AgentPresetDto) => { setEditing(preset); setName(preset?.name ?? ""); setDescription(preset?.description ?? ""); setGuidance(preset?.guidance ?? ""); setEngine(preset?.engine ?? engines[0]?.id ?? ""); setModel(preset?.model ?? ""); setEffort(preset?.effort ?? ""); setEnabled(preset?.enabled ?? true); };
  useEffect(() => { if (open && !editing && !engine && engines[0]) setEngine(engines[0].id); }, [editing, engine, engines, open]);
  const selected = engines.find((item) => item.id === engine);
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="md"><DialogTitle>Agent presets</DialogTitle><DialogContent>
    <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ pt: 1 }}>
      <Stack sx={{ minWidth: 260 }}><Button onClick={() => edit()}>New preset</Button><List>{presets.map((preset) => <ListItem key={preset.id} secondaryAction={<Button color="error" onClick={() => onDelete(preset.id)}>Delete</Button>}><ListItemText primary={preset.name} secondary={`${preset.enabled ? "Enabled" : "Disabled"} · ${preset.engine}`} onClick={() => edit(preset)} sx={{ cursor: "pointer" }} /></ListItem>)}</List></Stack>
      <Stack spacing={1.5} sx={{ flex: 1 }}>
        <TextField required label="Name" value={name} onChange={(e) => setName(e.target.value)} inputProps={{ maxLength: 60 }} />
        <TextField required label="Description" value={description} onChange={(e) => setDescription(e.target.value)} inputProps={{ maxLength: 240 }} />
        <TextField required label="Role / system guidance" helperText="At least 10 characters" multiline minRows={5} value={guidance} onChange={(e) => setGuidance(e.target.value)} inputProps={{ maxLength: 8000 }} />
        <FormControl required><InputLabel>Engine</InputLabel><Select label="Engine" value={engine} onChange={(e) => { setEngine(e.target.value); setModel(""); setEffort(""); }}>{engines.map((item) => <MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}</Select></FormControl>
        <Stack direction="row" spacing={1}><FormControl fullWidth><InputLabel>Model</InputLabel><Select label="Model" value={model} onChange={(e) => setModel(e.target.value)}><MenuItem value="">Default</MenuItem>{selected?.models.map((x) => <MenuItem key={x.id} value={x.id}>{x.label}</MenuItem>)}</Select></FormControl><FormControl fullWidth><InputLabel>Effort</InputLabel><Select label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}><MenuItem value="">Default</MenuItem>{selected?.efforts.map((x) => <MenuItem key={x.id} value={x.id}>{x.label}</MenuItem>)}</Select></FormControl></Stack>
        <FormControlLabel control={<Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="Enabled" />
        <Button variant="contained" disabled={!name.trim() || !description.trim() || guidance.trim().length < 10 || !engine} onClick={() => onSave(editing?.id, { name: name.trim(), description: description.trim(), guidance: guidance.trim(), engine, model: model || undefined, effort: effort || undefined, enabled })}>{editing ? "Save changes" : "Create preset"}</Button>
      </Stack>
    </Stack>
  </DialogContent><DialogActions><Button onClick={onClose}>Done</Button></DialogActions></Dialog>;
}

/**
 * Conversations are model-agnostic control rooms: an optional default engine just
 * prefills the agents spawned from here. The user can pick any engine per agent
 * and change it any time.
 */
export function CreateConversationDialog({
  open,
  engines,
  pending,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  engines: EngineDto[];
  pending: boolean;
  error?: string;
  onClose(): void;
  onCreate(input: CreateConversationInput): void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [engine, setEngine] = useState(UNSET);

  useEffect(() => {
    if (open) {
      setTitle("");
      setEngine(UNSET);
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New Conversation</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            fullWidth
          />
          <FormControl fullWidth size="small">
            <InputLabel id="master-default-engine-label">Default engine (optional)</InputLabel>
            <Select
              labelId="master-default-engine-label"
              label="Default engine (optional)"
              value={engine}
              onChange={(event: SelectChangeEvent) => setEngine(event.target.value)}
            >
              <MenuItem value={UNSET}>No default — choose per agent</MenuItem>
              {engines.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.displayName}
                  {option.authenticated ? "" : " — not signed in"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!title.trim() || pending}
          onClick={() =>
            onCreate({ title: title.trim(), defaultEngine: engine || undefined })
          }
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface CreateAgentInput {
  title: string;
  engine: string;
  model?: string;
  effort?: string;
  conversationId?: string;
  presetId?: string;
  managerAgentId?: string;
  initialMessage?: string;
}

export function activeManagerOptions(agents: ThreadDto[]): ThreadDto[] {
  return agents.filter((agent) => !agent.archived);
}

export function createAgentInputFromForm(input: {
  title: string;
  engine: string;
  model: string;
  effort: string;
  conversationId: string;
  presetId: string;
  managerAgentId: string;
  initialMessage: string;
}): CreateAgentInput {
  return {
    title: input.title.trim(),
    engine: input.engine,
    model: input.model || undefined,
    effort: input.effort || undefined,
    conversationId: input.conversationId || undefined,
    presetId: input.presetId || undefined,
    managerAgentId: input.managerAgentId || undefined,
    initialMessage: input.initialMessage.trim() || undefined,
  };
}

/**
 * Spawns an agent (thread). From a conversation, `fixedConversationId` locks the
 * manager and prefills defaults; from the Agents tab, the user may optionally
 * assign it to a conversation.
 */
export function CreateAgentDialog({
  open,
  engines,
  conversations,
  presets,
  agents,
  fixedConversationId,
  defaultEngine,
  defaultModel,
  defaultEffort,
  defaultName,
  defaultManagerAgentId,
  pending,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  engines: EngineDto[];
  conversations: ConversationDto[];
  presets: AgentPresetDto[];
  agents: ThreadDto[];
  fixedConversationId?: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** Suggested single-word (park) name, prefilled and editable. */
  defaultName?: string;
  defaultManagerAgentId?: string;
  pending: boolean;
  error?: string;
  onClose(): void;
  onCreate(input: CreateAgentInput): void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [engine, setEngine] = useState(UNSET);
  const [model, setModel] = useState(UNSET);
  const [effort, setEffort] = useState(UNSET);
  const [conversationId, setConversationId] = useState(UNSET);
  const [presetId, setPresetId] = useState(UNSET);
  const [managerAgentId, setManagerAgentId] = useState(UNSET);
  const [initialMessage, setInitialMessage] = useState("");

  useEffect(() => {
    if (open) {
      setTitle(defaultName ?? "");
      setEngine(defaultEngine ?? engines.find((candidate) => candidate.authenticated)?.id ?? engines[0]?.id ?? UNSET);
      setModel(defaultModel ?? UNSET);
      setEffort(defaultEffort ?? UNSET);
      setConversationId(fixedConversationId ?? UNSET);
      setPresetId(UNSET);
      setManagerAgentId(defaultManagerAgentId ?? UNSET);
      setInitialMessage("");
    }
  }, [open, defaultEngine, defaultModel, defaultEffort, defaultName, defaultManagerAgentId, fixedConversationId, engines]);

  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const models = activeEngine?.models ?? [];
  const efforts = activeEngine?.efforts ?? [];

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New Agent</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <FormControl fullWidth size="small">
            <InputLabel id="agent-preset-label">Preset (optional)</InputLabel>
            <Select labelId="agent-preset-label" label="Preset (optional)" value={presetId} onChange={(event: SelectChangeEvent) => {
              const id = event.target.value; setPresetId(id); const preset = presets.find((p) => p.id === id);
              if (preset) { setEngine(preset.engine); setModel(preset.model ?? UNSET); setEffort(preset.effort ?? UNSET); }
            }}>
              <MenuItem value={UNSET}>Custom</MenuItem>
              {presets.filter((preset) => preset.enabled).map((preset) => <MenuItem key={preset.id} value={preset.id}>{preset.name} — {preset.description}</MenuItem>)}
            </Select>
          </FormControl>
          <TextField
            label="Name"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            fullWidth
          />
          <FormControl fullWidth size="small">
            <InputLabel id="agent-engine-label">Engine</InputLabel>
            <Select
              labelId="agent-engine-label"
              label="Engine"
              value={engine}
              onChange={(event: SelectChangeEvent) => {
                setEngine(event.target.value);
                setModel(UNSET);
                setEffort(UNSET);
              }}
            >
              {engines.map((option) => (
                <MenuItem key={option.id} value={option.id} disabled={!option.authenticated}>
                  {option.displayName}
                  {option.authenticated ? "" : " — not signed in"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {models.length > 0 ? (
            <FormControl fullWidth size="small">
              <InputLabel id="agent-model-label">Model</InputLabel>
              <Select
                labelId="agent-model-label"
                label="Model"
                value={models.some((option) => option.id === model) ? model : UNSET}
                onChange={(event: SelectChangeEvent) => setModel(event.target.value)}
              >
                <MenuItem value={UNSET}>Engine default</MenuItem>
                {models.map((option) => (
                  <MenuItem key={option.id} value={option.id}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          {efforts.length > 0 ? (
            <FormControl fullWidth size="small">
              <InputLabel id="agent-effort-label">Effort</InputLabel>
              <Select
                labelId="agent-effort-label"
                label="Effort"
                value={efforts.some((option) => option.id === effort) ? effort : UNSET}
                onChange={(event: SelectChangeEvent) => setEffort(event.target.value)}
              >
                <MenuItem value={UNSET}>Engine default</MenuItem>
                {efforts.map((option) => (
                  <MenuItem key={option.id} value={option.id}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          {!fixedConversationId ? (
            <FormControl fullWidth size="small">
              <InputLabel id="agent-master-label">Master chat (optional)</InputLabel>
              <Select
                labelId="agent-master-label"
                label="Master chat (optional)"
                value={conversationId}
                onChange={(event: SelectChangeEvent) => setConversationId(event.target.value)}
              >
                <MenuItem value={UNSET}>Unassigned</MenuItem>
                {conversations.map((master) => (
                  <MenuItem key={master.id} value={master.id}>
                    {master.title}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          <FormControl fullWidth size="small">
            <InputLabel id="agent-manager-label">Reports to</InputLabel>
            <Select
              labelId="agent-manager-label"
              label="Reports to"
              value={managerAgentId}
              onChange={(event: SelectChangeEvent) => setManagerAgentId(event.target.value)}
            >
              <MenuItem value={UNSET}>User / Top level</MenuItem>
              {activeManagerOptions(agents).map((agent) => (
                <MenuItem key={agent.id} value={agent.id}>{agent.title}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Initial message (optional)"
            helperText="Give the agent a task, role, or introduction—or leave it idle."
            value={initialMessage}
            onChange={(event) => setInitialMessage(event.target.value)}
            multiline
            minRows={3}
            inputProps={{ maxLength: 4000 }}
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!title.trim() || !engine || pending}
          onClick={() =>
            onCreate(createAgentInputFromForm({
              title,
              engine,
              model,
              effort,
              conversationId: fixedConversationId ?? conversationId,
              presetId,
              managerAgentId,
              initialMessage,
            }))
          }
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
