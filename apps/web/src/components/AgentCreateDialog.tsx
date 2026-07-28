import {
  Alert,
  Button,
  Dialog,
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
import type { AgentDto, EngineDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  effortSelectionIsCompatible,
  engineIsAvailable,
  modelSelectionIsCompatible,
} from "../conversationEngine";
import { useAgentPresets } from "../hooks/queries";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import { EngineModelEffortFields } from "./ProjectRuntimeFields";

const UNSET = "";

export interface AgentCreateFormProps {
  projects: ProjectDto[];
  engines: EngineDto[];
  initialProjectId?: string;
  fixedProjectId?: string;
  fixedConversationId?: string;
  initialManagerAgentId?: string;
  initialEngine?: string;
  initialModel?: string;
  initialEffort?: string;
  initialName?: string;
  onCancel(): void;
  onCreated(projectId: string, agent: AgentDto): void;
}

export function AgentCreateForm({
  projects,
  engines,
  initialProjectId,
  fixedProjectId,
  fixedConversationId,
  initialManagerAgentId,
  initialEngine,
  initialModel,
  initialEffort,
  initialName,
  onCancel,
  onCreated,
}: AgentCreateFormProps): JSX.Element {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(
    fixedProjectId ??
      (projects.some(project => project.id === initialProjectId)
        ? initialProjectId!
        : projects[0]?.id ?? ""),
  );
  const project = projects.find(candidate => candidate.id === projectId);
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.project(projectId),
    queryFn: () => api.listAgents(projectId),
    enabled: Boolean(projectId),
  });
  const chatsQuery = useQuery({
    queryKey: queryKeys.conversations.project(projectId),
    queryFn: () => api.listConversations(projectId),
    enabled: Boolean(projectId),
  });
  const presetsQuery = useAgentPresets(projectId || undefined);
  const agents = agentsQuery.data ?? [];
  const chats = chatsQuery.data ?? [];
  const presets = presetsQuery.data ?? [];
  const [title, setTitle] = useState(initialName ?? "");
  const [engine, setEngine] = useState(UNSET);
  const [model, setModel] = useState(UNSET);
  const [effort, setEffort] = useState(UNSET);
  const [conversationId, setConversationId] = useState(
    fixedConversationId ?? UNSET,
  );
  const [presetId, setPresetId] = useState(UNSET);
  const [managerAgentId, setManagerAgentId] = useState(UNSET);
  const [initialMessage, setInitialMessage] = useState("");
  const titleEditedRef = useRef(Boolean(initialName));
  const managerEditedRef = useRef(false);

  useEffect(() => {
    titleEditedRef.current = Boolean(initialName);
    managerEditedRef.current = false;
    setTitle(initialName ?? pickAgentName([]));
    setEngine(
      initialEngine ??
        project?.defaultEngine ??
        engines.find(engineIsAvailable)?.id ??
        engines[0]?.id ??
        UNSET,
    );
    setModel(initialModel ?? project?.defaultModel ?? UNSET);
    setEffort(initialEffort ?? project?.defaultEffort ?? UNSET);
    setConversationId(fixedConversationId ?? UNSET);
    setPresetId(UNSET);
    setManagerAgentId(UNSET);
    setInitialMessage("");
  }, [
    engines,
    fixedConversationId,
    initialEffort,
    initialEngine,
    initialModel,
    initialName,
    project?.defaultEffort,
    project?.defaultEngine,
    project?.defaultModel,
    projectId,
  ]);

  useEffect(() => {
    if (!agentsQuery.isSuccess) return;
    const loadedAgents = agentsQuery.data ?? [];
    if (!titleEditedRef.current) {
      setTitle(pickAgentName(loadedAgents.map(agent => agent.title)));
    }
    if (!managerEditedRef.current) {
      setManagerAgentId(
        loadedAgents.some(agent => agent.id === initialManagerAgentId)
          ? initialManagerAgentId!
          : UNSET,
      );
    }
  }, [agentsQuery.data, agentsQuery.isSuccess, initialManagerAgentId]);

  const activeEngine = engines.find(candidate => candidate.id === engine);
  const create = useMutation({
    mutationFn: () =>
      api.createAgent(projectId, conversationId || undefined, {
        title: title.trim(),
        engine,
        model: modelSelectionIsCompatible(activeEngine, model)
          ? model || undefined
          : undefined,
        effort: effortSelectionIsCompatible(activeEngine, model, effort)
          ? effort || undefined
          : undefined,
        presetId: presetId || undefined,
        managerAgentId: managerAgentId || undefined,
        initialMessage: initialMessage.trim() || undefined,
      }),
    onSuccess: agent => {
      queryClient.setQueryData<AgentDto[]>(
        queryKeys.agents.project(projectId),
        (current = []) =>
          current.some(item => item.id === agent.id)
            ? current
            : [...current, agent],
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.project(projectId),
      });
      if (agent.conversationId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.conversations.detailPrefix(agent.conversationId),
        });
      }
      onCreated(projectId, agent);
    },
  });

  return (
    <Stack spacing={2.25}>
      {!fixedProjectId ? (
        <FormControl fullWidth>
          <InputLabel id="create-agent-project-label">Project</InputLabel>
          <Select
            labelId="create-agent-project-label"
            label="Project"
            value={projectId}
            onChange={event => setProjectId(event.target.value)}
          >
            {projects.map(option => (
              <MenuItem key={option.id} value={option.id}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : null}
      <FormControl fullWidth size="small">
        <InputLabel id="create-agent-preset-label">Preset (optional)</InputLabel>
        <Select
          labelId="create-agent-preset-label"
          label="Preset (optional)"
          value={presetId}
          onChange={(event: SelectChangeEvent) => {
            const id = event.target.value;
            setPresetId(id);
            const preset = presets.find(candidate => candidate.id === id);
            if (preset) {
              setEngine(preset.engine);
              setModel(preset.model ?? UNSET);
              setEffort(preset.effort ?? UNSET);
            }
          }}
        >
          <MenuItem value={UNSET}>Custom</MenuItem>
          {presets
            .filter(preset => preset.enabled)
            .map(preset => (
              <MenuItem key={preset.id} value={preset.id}>
                {preset.name} — {preset.description}
              </MenuItem>
            ))}
        </Select>
      </FormControl>
      <TextField
        label="Name"
        value={title}
        onChange={event => {
          titleEditedRef.current = true;
          setTitle(event.target.value);
        }}
        autoFocus
        fullWidth
      />
      <FormControl fullWidth size="small">
        <InputLabel id="create-agent-engine-label">Engine</InputLabel>
        <Select
          labelId="create-agent-engine-label"
          label="Engine"
          value={engine}
          onChange={(event: SelectChangeEvent) => {
            setEngine(event.target.value);
            setModel(UNSET);
            setEffort(UNSET);
          }}
        >
          {engines.map(option => (
            <MenuItem
              key={option.id}
              value={option.id}
              disabled={!engineIsAvailable(option)}
            >
              {option.displayName}
              {engineIsAvailable(option)
                ? ""
                : option.authenticated
                  ? " — Unavailable"
                  : " — Not Signed In"}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <EngineModelEffortFields
        engine={activeEngine}
        selection={{ model, effort }}
        onChange={selection => {
          setModel(selection.model);
          setEffort(selection.effort);
        }}
        modelLabel="Model"
        effortLabel="Effort"
        modelLabelId="create-agent-model-label"
        effortLabelId="create-agent-effort-label"
        modelEmptyLabel="Engine Default"
        effortEmptyLabel="Engine Default"
        size="small"
        runtimeSpacing={2}
        hideModelWhenEmpty
        hideEffortWhenEmpty
      />
      {!fixedConversationId ? (
        <FormControl fullWidth size="small">
          <InputLabel id="create-agent-chat-label">
            Project chat (optional)
          </InputLabel>
          <Select
            labelId="create-agent-chat-label"
            label="Project chat (optional)"
            value={conversationId}
            onChange={(event: SelectChangeEvent) =>
              setConversationId(event.target.value)
            }
          >
            <MenuItem value={UNSET}>Unassigned</MenuItem>
            {chats
              .filter(chat => !chat.archived)
              .map(chat => (
                <MenuItem key={chat.id} value={chat.id}>
                  {chat.title}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
      ) : null}
      <FormControl fullWidth size="small">
        <InputLabel id="create-agent-manager-label">Delegated under</InputLabel>
        <Select
          labelId="create-agent-manager-label"
          label="Delegated under"
          value={managerAgentId}
          onChange={(event: SelectChangeEvent) => {
            managerEditedRef.current = true;
            setManagerAgentId(event.target.value);
          }}
        >
          <MenuItem value={UNSET}>User / Top Level</MenuItem>
          {agents
            .filter(agent => !agent.archived)
            .map(agent => (
              <MenuItem key={agent.id} value={agent.id}>
                {agent.title}
              </MenuItem>
            ))}
        </Select>
      </FormControl>
      <TextField
        label="Initial message (optional)"
        helperText="Give the Agent a task, role, or introduction—or leave it idle."
        value={initialMessage}
        onChange={event => setInitialMessage(event.target.value)}
        multiline
        minRows={3}
      />
      {!projects.length ? (
        <Alert severity="info">
          Create a Project before creating an Agent.
        </Alert>
      ) : null}
      {create.isError ? (
        <Alert severity="error">{String(create.error)}</Alert>
      ) : null}
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button disabled={create.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={
            !projectId || !title.trim() || !engine || create.isPending
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : "Create Agent"}
        </Button>
      </Stack>
    </Stack>
  );
}

export function AgentCreateDialog({
  open,
  ...formProps
}: AgentCreateFormProps & { open: boolean }): JSX.Element {
  return (
    <Dialog open={open} onClose={formProps.onCancel} fullWidth maxWidth="sm">
      <DialogTitle>New Agent</DialogTitle>
      <DialogContent sx={{ pt: "12px !important" }}>
        {open ? <AgentCreateForm {...formProps} /> : null}
      </DialogContent>
    </Dialog>
  );
}
