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
import type {
  AgentPresetDto,
  CreateAgentPresetRequest,
  EngineDto,
} from "@ponderosa/core";
import { useEffect, useRef, useState } from "react";
import { effortSelectionIsCompatible, modelSelectionIsCompatible } from "../conversationEngine";
import { createClientId } from "../clientId";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";
import { EngineModelEffortFields } from "./ProjectRuntimeFields";

const UNSET = "";

export function PresetManagerDialog({ open, engines, presets, onClose, onSave, onDelete }: {
  open: boolean;
  engines: EngineDto[];
  presets: AgentPresetDto[];
  onClose(): void;
  onSave(id: string | undefined, input: CreateAgentPresetRequest, idempotencyKey?: string): Promise<void>;
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
  const creationIdempotencyKey = useRef(createClientId("preset-create-"));
  const edit = (preset?: AgentPresetDto) => {
    if (!preset) creationIdempotencyKey.current = createClientId("preset-create-");
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
      }, editing ? undefined : creationIdempotencyKey.current);
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
    <ResourceDeletionDialog
      open={Boolean(deleting)}
      resourceType="Preset"
      resourceName={deleting?.name}
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
      Agents already created from this Preset keep their saved guidance.
    </ResourceDeletionDialog>
  </>;
}
