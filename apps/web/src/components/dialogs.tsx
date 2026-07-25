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
import type {
  AgentDto,
  AgentPresetDto,
  ConversationDto,
  CreateAgentPresetRequest,
  EngineDto,
} from "@ponderosa/core";
import { useEffect, useState } from "react";
import { effortSelectionIsCompatible, engineIsAvailable, modelSelectionIsCompatible } from "../conversationEngine";
import { DestructiveConfirmDialog } from "./ConfirmationDialogs";
import { EngineModelEffortFields } from "./ProjectRuntimeFields";

const UNSET = "";

export interface CreateConversationInput {
  title: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export function PresetManagerDialog({ open, engines, presets, onClose, onSave, onDelete }: {
  open: boolean;
  engines: EngineDto[];
  presets: AgentPresetDto[];
  onClose(): void;
  onSave(id: string | undefined, input: CreateAgentPresetRequest): Promise<void>;
  onDelete(id: string): Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState<AgentPresetDto | undefined>();
  const [deleting, setDeleting] = useState<AgentPresetDto | undefined>();
  const [pendingAction, setPendingAction] = useState<"save" | "delete">();
  const [actionError, setActionError] = useState<{ action: "save" | "delete"; message: string }>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [guidance, setGuidance] = useState("");
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [enabled, setEnabled] = useState(true);
  const edit = (preset?: AgentPresetDto) => {
    setEditing(preset);
    setName(preset?.name ?? "");
    setDescription(preset?.description ?? "");
    setGuidance(preset?.guidance ?? "");
    setEngine(preset?.engine ?? engines[0]?.id ?? "");
    setModel(preset?.model ?? "");
    setEffort(preset?.effort ?? "");
    setEnabled(preset?.enabled ?? true);
    setActionError(undefined);
  };
  useEffect(() => { if (open && !editing && !engine && engines[0]) setEngine(engines[0].id); }, [editing, engine, engines, open]);
  const selected = engines.find((item) => item.id === engine);
  const engineValue = selected?.id ?? UNSET;
  const save = async () => {
    if (!selected) return;
    const modelValue = modelSelectionIsCompatible(selected, model) ? model : UNSET;
    const effortValue = effortSelectionIsCompatible(selected, modelValue, effort) ? effort : UNSET;
    setActionError(undefined);
    setPendingAction("save");
    try {
      await onSave(editing?.id, {
        name: name.trim(),
        description: description.trim(),
        guidance: guidance.trim(),
        engine: selected.id,
        model: modelSelectionIsCompatible(selected, modelValue) ? modelValue || undefined : undefined,
        effort: effortSelectionIsCompatible(selected, modelValue, effortValue) ? effortValue || undefined : undefined,
        enabled,
      });
      if (!editing) edit();
    } catch (error) {
      setActionError({ action: "save", message: String(error) });
    } finally {
      setPendingAction(undefined);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    setActionError(undefined);
    setPendingAction("delete");
    try {
      await onDelete(deleting.id);
      if (editing?.id === deleting.id) edit();
      setDeleting(undefined);
    } catch (error) {
      setActionError({ action: "delete", message: String(error) });
    } finally {
      setPendingAction(undefined);
    }
  };
  const close = () => {
    if (!pendingAction) onClose();
  };
  return <>
    <Dialog open={open} onClose={close} fullWidth maxWidth="md">
      <DialogTitle>Agent presets</DialogTitle>
      <DialogContent>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ pt: 1 }}>
          <Stack sx={{ minWidth: 260 }}>
            <Button onClick={() => edit()}>New Preset</Button>
            <List>
              {presets.map((preset) => (
                <ListItem
                  key={preset.id}
                  secondaryAction={<Button color="error" onClick={() => { setActionError(undefined); setDeleting(preset); }}>Delete</Button>}
                >
                  <ListItemText
                    primary={preset.name}
                    secondary={`${preset.enabled ? "Enabled" : "Disabled"} · ${preset.engine}`}
                    onClick={() => edit(preset)}
                    sx={{ cursor: "pointer" }}
                  />
                </ListItem>
              ))}
            </List>
          </Stack>
          <Stack spacing={1.5} sx={{ flex: 1 }}>
            <TextField required label="Name" value={name} onChange={(event) => setName(event.target.value)} inputProps={{ maxLength: 60 }} />
            <TextField required label="Description" value={description} onChange={(event) => setDescription(event.target.value)} inputProps={{ maxLength: 240 }} />
            <TextField required label="Role / system guidance" helperText="At least 10 characters" multiline minRows={5} value={guidance} onChange={(event) => setGuidance(event.target.value)} inputProps={{ maxLength: 8000 }} />
            <FormControl required>
              <InputLabel>Engine</InputLabel>
              <Select label="Engine" value={engineValue} onChange={(event) => {
                setEngine(event.target.value);
                setModel(UNSET);
                setEffort(UNSET);
              }}>
                {engines.map((item) => <MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}
              </Select>
            </FormControl>
            <EngineModelEffortFields
              engine={selected}
              selection={{ model, effort }}
              onChange={(selection) => {
                setModel(selection.model);
                setEffort(selection.effort);
              }}
              modelLabel="Model"
              effortLabel="Effort"
              modelEmptyLabel="Default"
              effortEmptyLabel="Default"
              runtimeDirection="row"
              runtimeSpacing={1}
            />
            <FormControlLabel control={<Checkbox checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />} label="Enabled" />
            {actionError?.action === "save" ? <Alert severity="error">{actionError.message}</Alert> : null}
            <Button
              variant="contained"
              disabled={!name.trim() || !description.trim() || guidance.trim().length < 10 || !selected || Boolean(pendingAction)}
              onClick={() => void save()}
            >
              {pendingAction === "save" ? "Saving…" : editing ? "Save Changes" : "Create Preset"}
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={close} disabled={Boolean(pendingAction)}>Done</Button></DialogActions>
    </Dialog>
    <DestructiveConfirmDialog
      open={Boolean(deleting)}
      title="Delete preset?"
      confirmLabel="Delete Preset"
      pending={pendingAction === "delete"}
      pendingLabel="Deleting"
      error={actionError?.action === "delete" ? actionError.message : undefined}
      onCancel={() => {
        if (pendingAction !== "delete") {
          setDeleting(undefined);
          setActionError(undefined);
        }
      }}
      onConfirm={() => void remove()}
    >
      Delete <strong>{deleting?.name}</strong>? Agents already created from this preset keep their saved guidance.
    </DestructiveConfirmDialog>
  </>;
}

/**
 * Project chats are model-agnostic: an optional default engine just
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
      <DialogTitle>New Project chat</DialogTitle>
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
              <MenuItem value={UNSET}>No Default — Choose per Agent</MenuItem>
              {engines.map((option) => (
                <MenuItem key={option.id} value={option.id} disabled={!engineIsAvailable(option)}>
                  {option.displayName}
                  {engineIsAvailable(option) ? "" : option.authenticated ? " — Unavailable" : " — Not Signed In"}
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

function activeManagerOptions(agents: AgentDto[]): AgentDto[] {
  return agents.filter((agent) => !agent.archived);
}

function createAgentInputFromForm(input: {
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
 * Spawns an agent. From a Project chat, `fixedConversationId` locks the
 * manager and prefills defaults; from the Agents tab, the user may optionally
 * assign it to a Project chat.
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
  agents: AgentDto[];
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
      setEngine(defaultEngine ?? engines.find(engineIsAvailable)?.id ?? engines[0]?.id ?? UNSET);
      setModel(defaultModel ?? UNSET);
      setEffort(defaultEffort ?? UNSET);
      setConversationId(fixedConversationId ?? UNSET);
      setPresetId(UNSET);
      setManagerAgentId(defaultManagerAgentId ?? UNSET);
      setInitialMessage("");
    }
  }, [open, defaultEngine, defaultModel, defaultEffort, defaultName, defaultManagerAgentId, fixedConversationId, engines]);

  const activeEngine = engines.find((candidate) => candidate.id === engine);

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
                <MenuItem key={option.id} value={option.id} disabled={!engineIsAvailable(option)}>
                  {option.displayName}
                  {engineIsAvailable(option) ? "" : option.authenticated ? " — Unavailable" : " — Not Signed In"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <EngineModelEffortFields
            engine={activeEngine}
            selection={{ model, effort }}
            onChange={(selection) => {
              setModel(selection.model);
              setEffort(selection.effort);
            }}
            modelLabel="Model"
            effortLabel="Effort"
            modelLabelId="agent-model-label"
            effortLabelId="agent-effort-label"
            modelEmptyLabel="Engine Default"
            effortEmptyLabel="Engine Default"
            size="small"
            runtimeSpacing={2}
            hideModelWhenEmpty
            hideEffortWhenEmpty
          />
          {!fixedConversationId ? (
            <FormControl fullWidth size="small">
              <InputLabel id="agent-master-label">Project chat (optional)</InputLabel>
              <Select
                labelId="agent-master-label"
                label="Project chat (optional)"
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
            <InputLabel id="agent-manager-label">Delegated under</InputLabel>
            <Select
              labelId="agent-manager-label"
              label="Delegated under"
              value={managerAgentId}
              onChange={(event: SelectChangeEvent) => setManagerAgentId(event.target.value)}
            >
              <MenuItem value={UNSET}>User / Top Level</MenuItem>
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
              model: modelSelectionIsCompatible(activeEngine, model) ? model : UNSET,
              effort: effortSelectionIsCompatible(activeEngine, model, effort) ? effort : UNSET,
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
