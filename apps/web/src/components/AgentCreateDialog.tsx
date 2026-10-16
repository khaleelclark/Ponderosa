import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { publishCreatedAgent } from "../conversationAgentCache";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { AgentDto, EngineDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import {
  effortSelectionIsCompatible,
  engineUnavailableReason,
  engineIsAvailable,
  modelSelectionIsCompatible,
  soleAvailableEngineId,
} from "../conversationEngine";
import { useAgentPresets, useConversation } from "../hooks/queries";
import { useProjectAgents, useProjectConversations } from "../hooks/useProjectCollections";
import { pickAgentName } from "../parkNames";
import { queryKeys } from "../queryKeys";
import { fixedCreateConversationMatchesProject } from "../routeRegistry";
import { EngineModelEffortFields } from "./ProjectRuntimeFields";
import { ImportAgentForm } from "./ImportAgentDialog";
import { retainIdempotentAttempt, type IdempotentAttempt } from "./idempotentAttempt";
import {
  reconcileAgentCreateOwnership,
  type AgentCreateOwnership,
} from "./agentCreateOwnership";

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
  onPendingChange?(pending: boolean): void;
  stickyActions?: boolean;
}

export interface AgentCreateSurfaceProps extends AgentCreateFormProps {
  onImported(projectId: string, agentId: string): void;
  onImportSubmitted?(): void;
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
  onPendingChange,
  stickyActions = false,
}: AgentCreateFormProps): JSX.Element {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(
    fixedProjectId ??
      (projects.some(project => project.id === initialProjectId)
        ? initialProjectId!
        : projects[0]?.id ?? ""),
  );
  const project = projects.find(candidate => candidate.id === projectId);
  const fixedConversationRequested = Boolean(
    fixedConversationId && projectId === (fixedProjectId ?? initialProjectId),
  );
  const fixedConversationQuery = useConversation(
    fixedConversationRequested ? fixedConversationId : undefined,
    1,
  );
  const verifiedFixedConversation = fixedCreateConversationMatchesProject(
    projectId,
    fixedConversationId,
    fixedConversationQuery.data?.conversation,
  ) ? fixedConversationQuery.data!.conversation : undefined;
  const effectiveFixedConversationId = verifiedFixedConversation?.id;
  const fixedConversationLoading = fixedConversationRequested && fixedConversationQuery.isPending;
  const fixedConversationInvalid = fixedConversationRequested && !fixedConversationLoading && !verifiedFixedConversation;
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
  const fixedConversation = verifiedFixedConversation;
  const presets = presetsQuery.data ?? [];
  const [title, setTitle] = useState(initialName ?? "");
  const [engine, setEngine] = useState(UNSET);
  const [model, setModel] = useState(UNSET);
  const [effort, setEffort] = useState(UNSET);
  const [ownership, setOwnership] = useState<AgentCreateOwnership>({
    conversationId: fixedConversationId ?? UNSET,
    managerAgentId: UNSET,
  });
  const { conversationId, managerAgentId } = ownership;
  const [presetId, setPresetId] = useState(UNSET);
  const [initialMessage, setInitialMessage] = useState("");
  const titleEditedRef = useRef(Boolean(initialName));
  const conversationEditedRef = useRef(false);
  const managerEditedRef = useRef(false);
  const pendingRef = useRef(false);
  const createAttemptRef = useRef<IdempotentAttempt<undefined> | undefined>(undefined);
  const initializedRef = useRef(false);
  const previousProjectIdRef = useRef(projectId);

  useEffect(() => {
    if (!projects.length) return;
    setProjectId(current => {
      if (projects.some(candidate => candidate.id === current)) return current;
      if (fixedProjectId && projects.some(candidate => candidate.id === fixedProjectId)) {
        return fixedProjectId;
      }
      if (initialProjectId && projects.some(candidate => candidate.id === initialProjectId)) {
        return initialProjectId;
      }
      return projects[0]!.id;
    });
  }, [fixedProjectId, initialProjectId, projects]);

  useEffect(() => {
    if (initializedRef.current) {
      if (previousProjectIdRef.current === projectId) return;
      const previousProjectId = previousProjectIdRef.current;
      previousProjectIdRef.current = projectId;
      conversationEditedRef.current = false;
      managerEditedRef.current = false;
      setOwnership({
        conversationId: effectiveFixedConversationId ?? UNSET,
        managerAgentId: UNSET,
      });
      setPresetId(UNSET);
      if (!previousProjectId) {
        setEngine(
          initialEngine ??
            project?.defaultEngine ??
            soleAvailableEngineId(engines) ??
            UNSET,
        );
        setModel(initialModel ?? project?.defaultModel ?? UNSET);
        setEffort(initialEffort ?? project?.defaultEffort ?? UNSET);
      }
      return;
    }
    initializedRef.current = true;
    previousProjectIdRef.current = projectId;
    titleEditedRef.current = Boolean(initialName);
    conversationEditedRef.current = false;
    managerEditedRef.current = false;
    setTitle(initialName ?? pickAgentName([]));
    setEngine(
      initialEngine ??
        project?.defaultEngine ??
        soleAvailableEngineId(engines) ??
        UNSET,
    );
    setModel(initialModel ?? project?.defaultModel ?? UNSET);
    setEffort(initialEffort ?? project?.defaultEffort ?? UNSET);
    setOwnership({
      conversationId: fixedConversationId ?? UNSET,
      managerAgentId: UNSET,
    });
    setPresetId(UNSET);
    setInitialMessage("");
  }, [
    engines,
    effectiveFixedConversationId,
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
    if (
      !titleEditedRef.current &&
      !pendingRef.current &&
      !createAttemptRef.current
    ) {
      setTitle(pickAgentName(loadedAgents.map(agent => agent.title)));
    }
  }, [agentsQuery.data, agentsQuery.isSuccess, initialManagerAgentId]);

  useEffect(() => {
    setOwnership(current => reconcileAgentCreateOwnership(current, {
      agents,
      agentsResolved: agentsQuery.isSuccess,
      chats,
      chatsResolved: chatsQuery.isSuccess,
      initialManagerAgentId,
      requiredInitialManagerConversationId:
        fixedConversationRequested ? fixedConversationId : undefined,
      fixedConversationId: effectiveFixedConversationId,
      conversationEdited: conversationEditedRef.current,
      managerEdited: managerEditedRef.current,
    }));
  }, [
    agents,
    agentsQuery.isSuccess,
    chats,
    chatsQuery.isSuccess,
    effectiveFixedConversationId,
    fixedConversationId,
    fixedConversationRequested,
    initialManagerAgentId,
  ]);

  const activeEngine = engines.find(candidate => candidate.id === engine);
  const conversationAvailable = Boolean(
    effectiveFixedConversationId ||
    chats.some(chat => chat.id === conversationId && !chat.deletedAt),
  );
  const create = useMutation({
    mutationFn: () => {
      const options = {
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
      };
      createAttemptRef.current = retainIdempotentAttempt(
        createAttemptRef.current,
        JSON.stringify({ projectId, conversationId, ...options }),
        () => createClientId("agent-create-"),
        () => undefined,
      );
      return api.createAgent(projectId, conversationId, {
        ...options,
        idempotencyKey: createAttemptRef.current.idempotencyKey,
      });
    },
    onSuccess: agent => {
      createAttemptRef.current = undefined;
      if ("recovering" in agent) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.project(projectId),
        });
        return;
      }
      publishCreatedAgent(queryClient, agent);
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
    onSettled: () => {
      pendingRef.current = false;
      onPendingChange?.(false);
    },
  });

  if (create.data && "recovering" in create.data) {
    return (
      <Stack spacing={2.25}>
        <Alert severity="info">
          Agent creation is committed and recovery is finishing. It will appear when ready.
        </Alert>
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
          <Button onClick={onCancel}>Close</Button>
        </Stack>
      </Stack>
    );
  }

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
              {engineIsAvailable(option) ? "" : ` — ${engineUnavailableReason(option)}`}
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
      {fixedConversationInvalid ? (
        <Alert
          severity="warning"
          action={fixedConversationQuery.isError ? (
            <Button color="inherit" size="small" onClick={() => void fixedConversationQuery.refetch()}>
              Retry
            </Button>
          ) : undefined}
        >
          The requested Chat is not available. Choose another Chat.
        </Alert>
      ) : null}
      {!fixedConversationRequested || fixedConversationInvalid ? (
        <FormControl fullWidth size="small">
          <InputLabel id="create-agent-chat-label">
            Chat
          </InputLabel>
          <Select
            labelId="create-agent-chat-label"
            label="Chat"
            value={conversationId}
            onChange={(event: SelectChangeEvent) => {
              const nextConversationId = event.target.value;
              conversationEditedRef.current = true;
              managerEditedRef.current = true;
              setOwnership(current => ({
                conversationId: nextConversationId,
                managerAgentId: agents.some(agent =>
                  agent.id === current.managerAgentId && agent.conversationId === nextConversationId)
                  ? current.managerAgentId
                  : UNSET,
              }));
            }}
          >
            {chats
              .filter(chat => !chat.deletedAt)
              .map(chat => (
                <MenuItem key={chat.id} value={chat.id}>
                  {chat.title}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
      ) : (
        <TextField
          label="Chat"
          value={fixedConversation?.title ?? "Checking Chat…"}
          helperText="This Agent will join the Chat where creation was started."
          InputProps={{ readOnly: true }}
          fullWidth
          size="small"
        />
      )}
      <FormControl fullWidth size="small">
        <InputLabel id="create-agent-manager-label">Delegated under</InputLabel>
        <Select
          labelId="create-agent-manager-label"
          label="Delegated under"
          value={managerAgentId}
          onChange={(event: SelectChangeEvent) => {
            managerEditedRef.current = true;
            setOwnership(current => ({
              ...current,
              managerAgentId: event.target.value,
            }));
          }}
        >
          <MenuItem value={UNSET}>User / Top Level</MenuItem>
          {agents
            .filter(agent => agent.conversationId === conversationId)
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
          Create a Chat before creating an Agent.
        </Alert>
      ) : null}
      {create.isError ? (
        <Alert severity="error">{String(create.error)}</Alert>
      ) : null}
      <Stack direction="row" spacing={1} sx={{
        justifyContent: "flex-end",
        ...(stickyActions ? {
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
        <Button
          disabled={create.isPending}
          onClick={() => {
            if (!pendingRef.current) onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={
            !projectId || !conversationId || !conversationAvailable ||
            fixedConversationLoading || !title.trim() ||
            !engineIsAvailable(activeEngine) || create.isPending
          }
          onClick={() => {
            if (pendingRef.current) return;
            pendingRef.current = true;
            onPendingChange?.(true);
            create.mutate();
          }}
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
}: AgentCreateSurfaceProps & { open: boolean }): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={formProps.onCancel}
      fullWidth
      maxWidth="sm"
      aria-label="Create or import Agent"
    >
      <DialogContent sx={{ pt: "24px !important" }}>
        {open ? <AgentCreateSurface {...formProps} /> : null}
      </DialogContent>
    </Dialog>
  );
}

export function AgentCreateSurface(props: AgentCreateSurfaceProps): JSX.Element {
  const scopedProjectId = props.fixedProjectId ?? (props.fixedConversationId ? props.initialProjectId : undefined);
  const projects = scopedProjectId ? props.projects.filter(project => project.id === scopedProjectId) : props.projects;
  const queries = useProjectConversations(projects);
  const agentQueries = useProjectAgents(props.initialManagerAgentId ? projects : []);
  const manager = agentQueries.flatMap(query => query.data ?? []).find(agent => agent.id === props.initialManagerAgentId);
  const chats = projects.flatMap((project, index) =>
    (queries[index]?.data ?? []).filter(chat => !chat.deletedAt && (!props.fixedProjectId || project.id === props.fixedProjectId))
      .map(chat => ({ chat, projectId: project.id })),
  );
  const [selectedId, setSelectedId] = useState("");
  const [pending, setPending] = useState(false);
  const selected = selectedId ? chats.find(item => item.chat.id === selectedId)
    : (props.fixedConversationId ? chats.find(item => item.chat.id === props.fixedConversationId && (!props.initialProjectId || item.projectId === props.initialProjectId))
      : props.initialManagerAgentId ? chats.find(item => item.chat.id === manager?.conversationId)
      : chats.find(item => item.projectId === props.initialProjectId) ?? chats[0]);
  useEffect(() => { if (selected && !selectedId) setSelectedId(selected.chat.id); }, [selected?.chat.id, selectedId]);
  if (props.fixedProjectId && props.fixedConversationId) return <ScopedAgentCreateSurface {...props} />;
  if (props.fixedConversationId && selected) return <ScopedAgentCreateSurface {...props} fixedProjectId={selected.projectId} />;
  return <Stack spacing={2}>
    <FormControl fullWidth size="small" disabled={pending}>
      <InputLabel id="agent-destination-chat-label">Chat</InputLabel>
      <Select labelId="agent-destination-chat-label" label="Chat" value={selected?.chat.id ?? ""}
        onChange={event => setSelectedId(event.target.value)}>
        {chats.map(({chat}) => <MenuItem key={chat.id} value={chat.id}>{chat.title}</MenuItem>)}
      </Select>
    </FormControl>
    {selected ? <ScopedAgentCreateSurface key={selected.chat.id} {...props}
      fixedProjectId={selected.projectId} fixedConversationId={selected.chat.id}
      onPendingChange={value => { setPending(value); props.onPendingChange?.(value); }} />
      : <Alert severity="info">{queries.some(query => query.isPending) ? "Loading Chats…" : "Create a Chat before adding an Agent."}</Alert>}
  </Stack>;
}

function ScopedAgentCreateSurface({
  projects,
  engines,
  initialProjectId,
  fixedProjectId,
  fixedConversationId,
  onCancel,
  onImported,
  onImportSubmitted,
  onPendingChange,
  stickyActions = false,
  ...createProps
}: AgentCreateSurfaceProps): JSX.Element {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [pending, setPending] = useState(false);
  const updatePending = (nextPending: boolean) => {
    setPending(nextPending);
    onPendingChange?.(nextPending);
  };
  const [importProjectId, setImportProjectId] = useState(
    fixedProjectId ??
      (projects.some(project => project.id === initialProjectId)
        ? initialProjectId!
        : projects[0]?.id ?? ""),
  );
  const importConversations = useQuery({
    queryKey: queryKeys.conversations.project(importProjectId),
    queryFn: () => api.listConversations(importProjectId),
    enabled: mode === "import" && Boolean(importProjectId),
  });

  const busyStatus = pending ? (
    <Alert severity="info" role="status" aria-live="polite">
      {mode === "import"
        ? "Importing Agent… Keep this window open."
        : "Creating Agent… Keep this window open."}
    </Alert>
  ) : null;

  if (mode === "import") {
    const conversations =
      importConversations.data ??
      [];
    return (
      <Stack spacing={2}>
        {busyStatus}
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          <div>
            <Typography variant="h6">Import Agent package</Typography>
            <Typography variant="body2" color="text.secondary">
              Import one Agent or an organization into a chat.
            </Typography>
          </div>
          <Button
            color="inherit"
            startIcon={<ArrowBackIcon />}
            disabled={pending}
            onClick={() => setMode("create")}
          >
            Create new Agent
          </Button>
        </Stack>
        {!fixedProjectId ? (
          <FormControl fullWidth>
            <InputLabel id="import-agent-project-label">Project</InputLabel>
            <Select
              labelId="import-agent-project-label"
              label="Project"
              value={importProjectId}
              onChange={event => setImportProjectId(event.target.value)}
            >
              {projects.map(project => (
                <MenuItem key={project.id} value={project.id}>
                  {project.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
        {importProjectId ? (
          <ImportAgentForm
            key={importProjectId}
            projectId={importProjectId}
            engines={engines}
            conversations={conversations}
            fixedConversationId={fixedConversationId}
            requireDestinationSelection={!fixedConversationId}
            initialConversationId={
              fixedConversationId &&
              conversations.some(
                conversation => conversation.id === fixedConversationId,
              )
                ? fixedConversationId
                : undefined
            }
            onCancel={onCancel}
            onPendingChange={updatePending}
            onSubmitted={onImportSubmitted ?? onCancel}
            stickyActions={stickyActions}
          />
        ) : (
          <Alert severity="info">
            Create a Chat before importing an Agent.
          </Alert>
        )}
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      {busyStatus}
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", justifyContent: "space-between" }}
      >
        <div>
          <Typography variant="h6">Create Agent</Typography>
          <Typography variant="body2" color="text.secondary">
            Create a managed Agent in a chat.
          </Typography>
        </div>
        <Button
          variant="outlined"
          startIcon={<UploadFileOutlinedIcon />}
          disabled={pending}
          onClick={() => setMode("import")}
        >
          Import Agent package
        </Button>
      </Stack>
      <AgentCreateForm
        projects={projects}
        engines={engines}
        initialProjectId={initialProjectId}
        fixedProjectId={fixedProjectId}
        fixedConversationId={fixedConversationId}
        onCancel={onCancel}
        onPendingChange={updatePending}
        stickyActions={stickyActions}
        {...createProps}
      />
    </Stack>
  );
}
