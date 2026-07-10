import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { EngineDto, MasterChatDto } from "@ponderosa/core";
import { useEffect, useState } from "react";

const UNSET = "";

export interface CreateMasterChatInput {
  title: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
}

/**
 * Master chats are model-agnostic control rooms: an optional default engine just
 * prefills the agents spawned from here. The user can pick any engine per agent
 * and change it any time.
 */
export function CreateMasterChatDialog({
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
  onCreate(input: CreateMasterChatInput): void;
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
      <DialogTitle>New Master Chat</DialogTitle>
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
  masterChatId?: string;
}

/**
 * Spawns an agent (thread). From a master chat, `fixedMasterChatId` locks the
 * assignment and prefills defaults; from the Agents tab, the user may optionally
 * assign it to a master chat.
 */
export function CreateAgentDialog({
  open,
  engines,
  masterChats,
  fixedMasterChatId,
  defaultEngine,
  defaultModel,
  defaultEffort,
  pending,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  engines: EngineDto[];
  masterChats: MasterChatDto[];
  fixedMasterChatId?: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  pending: boolean;
  error?: string;
  onClose(): void;
  onCreate(input: CreateAgentInput): void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [engine, setEngine] = useState(UNSET);
  const [model, setModel] = useState(UNSET);
  const [effort, setEffort] = useState(UNSET);
  const [masterChatId, setMasterChatId] = useState(UNSET);

  useEffect(() => {
    if (open) {
      setTitle("");
      setEngine(defaultEngine ?? engines.find((candidate) => candidate.authenticated)?.id ?? engines[0]?.id ?? UNSET);
      setModel(defaultModel ?? UNSET);
      setEffort(defaultEffort ?? UNSET);
      setMasterChatId(fixedMasterChatId ?? UNSET);
    }
  }, [open, defaultEngine, defaultModel, defaultEffort, fixedMasterChatId, engines]);

  const activeEngine = engines.find((candidate) => candidate.id === engine);
  const models = activeEngine?.models ?? [];
  const efforts = activeEngine?.efforts ?? [];

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New Agent</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
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
          {!fixedMasterChatId ? (
            <FormControl fullWidth size="small">
              <InputLabel id="agent-master-label">Master chat (optional)</InputLabel>
              <Select
                labelId="agent-master-label"
                label="Master chat (optional)"
                value={masterChatId}
                onChange={(event: SelectChangeEvent) => setMasterChatId(event.target.value)}
              >
                <MenuItem value={UNSET}>Unassigned</MenuItem>
                {masterChats.map((master) => (
                  <MenuItem key={master.id} value={master.id}>
                    {master.title}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!title.trim() || !engine || pending}
          onClick={() =>
            onCreate({
              title: title.trim(),
              engine,
              model: model || undefined,
              effort: effort || undefined,
              masterChatId: (fixedMasterChatId ?? masterChatId) || undefined,
            })
          }
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
