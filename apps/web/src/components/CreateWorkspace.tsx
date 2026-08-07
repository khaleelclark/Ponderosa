import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
  createFilterOptions,
} from "@mui/material";
import type {
  AgentDto,
  EngineDto,
  ProjectDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { api } from "../api";
import {
  engineCanTestAccess,
  engineIsAvailable,
  resolveRuntimeSelection,
} from "../conversationEngine";
import {
  useProjectAgents,
  useProjectConversations,
} from "../hooks/useProjectCollections";
import {
  createProjectRequest,
  projectCreationDisabled,
  type ProjectFolderMode,
} from "../projectLifecycle";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { HostFolderPicker } from "./HostFolderPicker";
import { IconTitle } from "./IconTitle";
import { ProjectRuntimeFields } from "./ProjectRuntimeFields";
import { TriggersPane } from "./TriggersPane";
import { AgentCreateSurface } from "./AgentCreateDialog";

const UNSET = "";
type TriggerAgentOption = {
  project: ProjectDto;
  agent: AgentDto;
  conversationId: string;
  chatTitle?: string;
};
const filterTriggerAgents = createFilterOptions<TriggerAgentOption>({
  limit: 50,
  stringify: option =>
    `${option.agent.title} ${option.project.label} ${option.chatTitle ?? ""}`,
});

const resourcePresentation = {
  project: {
    icon: <FolderOutlinedIcon />,
    title: "Create Project",
    description: "Set up a workspace, its runtime defaults, and its working folder.",
  },
  chat: {
    icon: <ChatBubbleOutlineIcon />,
    title: "Create Chat",
    description: "Start a shared Project conversation for requests, decisions, and Agent work.",
  },
  agent: {
    icon: <SmartToyOutlinedIcon />,
    title: "Create Agent",
    description: "Add a managed worker with its own role, runtime, and Project authority.",
  },
  trigger: {
    icon: <BoltOutlinedIcon />,
    title: "Create Trigger",
    description: "Configure automation that starts Agent work from a schedule or event.",
  },
} satisfies Record<Extract<Route, { kind: "create" }>["resource"], {
  icon: ReactElement;
  title: string;
  description: string;
}>;

function CreateSurface({
  route,
  children,
}: {
  route: Extract<Route, { kind: "create" }>;
  children: ReactNode;
}): JSX.Element {
  const presentation = resourcePresentation[route.resource];
  return (
    <Box
      className="ponderosa-scroll"
      sx={{ minHeight: 0, overflowY: "auto", px: { xs: 2, md: 4 }, py: 3 }}
    >
      <Box sx={{ width: "100%", maxWidth: 780, mx: "auto" }}>
        <Box sx={{ minWidth: 0, mb: 2.5 }}>
          <IconTitle icon={presentation.icon} title={presentation.title} component="h1" />
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            {presentation.description}
          </Typography>
        </Box>
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          {children}
        </Paper>
      </Box>
    </Box>
  );
}

function ProjectCreateForm({
  engines,
  preferences,
  onCancel,
  onCreated,
}: {
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onCancel(): void;
  onCreated(project: ProjectDto): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [folderMode, setFolderMode] = useState<ProjectFolderMode>("none");
  const [defaultEngine, setDefaultEngine] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [defaultEffort, setDefaultEffort] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [engineToTest, setEngineToTest] = useState<EngineDto>();
  const createProject = useMutation({
    mutationFn: () => api.createProject(createProjectRequest({
      label,
      mode: folderMode,
      existingPath: path,
      defaultEngine: defaultEngine as ProjectDto["defaultEngine"],
      defaultModel,
      defaultEffort,
    })),
    onSuccess: project => {
      queryClient.setQueryData<ProjectDto[]>(queryKeys.projects.all, (current = []) =>
        current.some(item => item.id === project.id) ? current : [...current, project]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      onCreated(project);
    },
  });
  const recheckEngine = useMutation({
    mutationFn: (engineId: string) => api.recheckEngine(engineId),
    onSuccess: updated => {
      queryClient.setQueryData<EngineDto[]>(queryKeys.engines.all, current =>
        current?.map(candidate => candidate.id === updated.id ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all });
      if (updated.available) setDefaultEngine(updated.id);
      setEngineToTest(undefined);
    },
  });
  const selectedEngine = engines.find(candidate => candidate.id === defaultEngine);
  const inherited = resolveRuntimeSelection(selectedEngine, preferences);
  return (
    <>
      <Stack spacing={2.25}>
        <TextField label="Project Name" value={label} onChange={event => setLabel(event.target.value)} autoFocus fullWidth />
        <Box>
          <Typography variant="subtitle2">Default AI Runtime</Typography>
          <Typography variant="body2" color="text.secondary">Choose the provider for this Project. Chats and Agents can override its model and reasoning later.</Typography>
        </Box>
        <FormControl fullWidth>
          <InputLabel shrink id="create-project-engine-label">AI Provider</InputLabel>
          <Select
            labelId="create-project-engine-label"
            label="AI Provider"
            value={defaultEngine}
            displayEmpty
            onChange={event => {
              setDefaultEngine(event.target.value);
              setDefaultModel("");
              setDefaultEffort("");
            }}
          >
            <MenuItem value="" disabled>Select a Provider</MenuItem>
            {engines.map(engine => (
              <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>
                {engine.displayName}{engineIsAvailable(engine) ? "" : engine.authenticated ? " — Unavailable" : " — Not Signed In"}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <ProjectRuntimeFields
          engine={selectedEngine}
          inherited={inherited}
          model={defaultModel}
          effort={defaultEffort}
          onChange={selection => {
            setDefaultModel(selection.model);
            setDefaultEffort(selection.effort);
          }}
          modelLabel="Model"
          effortLabel="Reasoning"
          modelLabelId="create-project-model-label"
          effortLabelId="create-project-effort-label"
          inheritedPrefix="Provider Default"
          inheritedFallback="Automatic"
          disabled={!defaultEngine}
        />
        {engines.filter(engineCanTestAccess).map(engine => (
          <Alert
            key={engine.id}
            severity="warning"
            action={<Button color="inherit" size="small" disabled={recheckEngine.isPending} onClick={() => setEngineToTest(engine)}>Test Access</Button>}
          >
            {engine.displayName} is configured but unavailable. {engine.availabilityDetail}
          </Alert>
        ))}
        <Box>
          <Typography variant="subtitle2">Working Folder</Typography>
          <RadioGroup value={folderMode} onChange={event => {
            const mode = event.target.value as ProjectFolderMode;
            setFolderMode(mode);
            if (mode === "none") setPath("");
          }}>
            <FormControlLabel value="none" control={<Radio />} label="Private Empty Workspace" />
            <FormControlLabel value="existing" control={<Radio />} label="Use a Folder on This Host" />
          </RadioGroup>
          {folderMode === "existing" ? (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{path || "No folder selected"}</Typography>
              <Button variant="outlined" startIcon={<FolderOutlinedIcon />} onClick={() => setFolderPickerOpen(true)}>{path ? "Change Folder…" : "Choose Folder…"}</Button>
            </Stack>
          ) : <Typography variant="body2" color="text.secondary">Ponderosa will create a private empty workspace.</Typography>}
        </Box>
        {createProject.isError ? <Alert severity="error">{String(createProject.error)}</Alert> : null}
        <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
          <Button disabled={createProject.isPending} onClick={onCancel}>Cancel</Button>
          <Button
            variant="contained"
            disabled={projectCreationDisabled({ label, mode: folderMode, existingPath: path, defaultEngine, pending: createProject.isPending })}
            onClick={() => createProject.mutate()}
          >
            {createProject.isPending ? "Creating…" : "Create Project"}
          </Button>
        </Stack>
      </Stack>
      <HostFolderPicker
        open={folderPickerOpen}
        initialPath={path || undefined}
        onClose={() => setFolderPickerOpen(false)}
        onChoose={nextPath => {
          setFolderMode("existing");
          setPath(nextPath);
          setFolderPickerOpen(false);
        }}
      />
      <ConfirmDialog
        open={Boolean(engineToTest)}
        title={`Test ${engineToTest?.displayName ?? "provider"} access?`}
        confirmLabel="Test Access"
        pendingLabel="Testing…"
        pending={recheckEngine.isPending}
        error={recheckEngine.isError ? String(recheckEngine.error) : undefined}
        onCancel={() => {
          recheckEngine.reset();
          setEngineToTest(undefined);
        }}
        onConfirm={() => {
          if (engineToTest) recheckEngine.mutate(engineToTest.id);
        }}
      >
        <Typography sx={{ pt: 1 }}>This sends one minimal subscription-backed request.</Typography>
      </ConfirmDialog>
    </>
  );
}

function ChatCreateForm({
  projects,
  initialProjectId,
  onCancel,
  onCreated,
}: {
  projects: ProjectDto[];
  initialProjectId?: string;
  onCancel(): void;
  onCreated(projectId: string, conversationId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(
    projects.some(project => project.id === initialProjectId)
      ? initialProjectId!
      : projects[0]?.id ?? "",
  );
  const create = useMutation({
    mutationFn: () => api.createConversation(projectId, {}),
    onSuccess: async conversation => {
      await api.markProjectUsed(projectId, conversation.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.project(projectId) });
      onCreated(projectId, conversation.id);
    },
  });
  return (
    <Stack spacing={2.25}>
      <FormControl fullWidth>
        <InputLabel id="create-chat-project-label">Project</InputLabel>
        <Select autoFocus labelId="create-chat-project-label" label="Project" value={projectId} onChange={event => setProjectId(event.target.value)}>
          {projects.map(project => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}
        </Select>
      </FormControl>
      {!projects.length ? <Alert severity="info">Create a Project before creating a Chat.</Alert> : null}
      {create.isError ? <Alert severity="error">{String(create.error)}</Alert> : null}
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button disabled={create.isPending} onClick={onCancel}>Cancel</Button>
        <Button variant="contained" disabled={!projectId || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create Chat"}
        </Button>
      </Stack>
    </Stack>
  );
}

function TriggerCreateForm({
  projects,
  initialProjectId,
  initialConversationId,
  initialAgentId,
  onCancel,
  onCreated,
}: {
  projects: ProjectDto[];
  initialProjectId?: string;
  initialConversationId?: string;
  initialAgentId?: string;
  onCancel(): void;
  onCreated(projectId: string, agentId: string): void;
}): JSX.Element {
  const agentQueries = useProjectAgents(projects);
  const conversationQueries = useProjectConversations(projects);
  const options = projects
    .flatMap((project, index) => {
      if (initialProjectId && project.id !== initialProjectId) return [];
      const chats = conversationQueries[index]?.data ?? [];
      return (agentQueries[index]?.data ?? []).flatMap(agent => {
        if (agent.archived || agent.conversationIds.length === 0) return [];
        if (
          initialConversationId &&
          !agent.conversationIds.includes(initialConversationId)
        ) {
          return [];
        }
        const conversationId =
          initialConversationId ??
          agent.conversationId ??
          agent.conversationIds.find(id =>
            chats.some(chat => chat.id === id && !chat.archived)) ??
          agent.conversationIds[0]!;
        const chat = chats.find(candidate => candidate.id === conversationId);
        return [{
          project,
          agent,
          conversationId,
          ...(chat ? { chatTitle: chat.title } : {}),
        }];
      });
    })
    .sort((a, b) => b.agent.updatedAt.localeCompare(a.agent.updatedAt));
  const [agentId, setAgentId] = useState("");
  useEffect(() => {
    if (options.some(option => option.agent.id === initialAgentId)) {
      setAgentId(initialAgentId!);
      return;
    }
    setAgentId(current =>
      options.some(option => option.agent.id === current)
        ? current
        : options[0]?.agent.id ?? "",
    );
  }, [initialAgentId, options.map(option => option.agent.id).join(":")]);
  const selectedOption = options.find(option => option.agent.id === agentId);
  return (
    <Stack spacing={2.25}>
      <Autocomplete
          fullWidth
          options={options}
          value={selectedOption ?? null}
          onChange={(_event, value) => setAgentId(value?.agent.id ?? "")}
          filterOptions={filterTriggerAgents}
          groupBy={option => option.project.label}
          getOptionLabel={option =>
            `${option.agent.title} — ${option.project.label}`}
          isOptionEqualToValue={(option, value) =>
            option.agent.id === value.agent.id}
          noOptionsText="No Trigger-ready Agents found"
          ListboxProps={{ style: { maxHeight: 320 } }}
          renderInput={params => (
            <TextField
              {...params}
              label="Runs As"
              placeholder="Search Agents or Projects"
              helperText={
                selectedOption?.chatTitle
                  ? `Uses ${selectedOption.chatTitle}`
                  : "Choose the Agent that will run this automation."
              }
            />
          )}
          renderOption={(props, option) => (
            <Box component="li" {...props} key={option.agent.id}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700} noWrap>
                  {option.agent.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {option.project.label}
                  {option.chatTitle ? ` · ${option.chatTitle}` : ""}
                </Typography>
              </Box>
            </Box>
          )}
        />
      {agentQueries.some(query => query.isLoading) ? (
        <Typography variant="body2" color="text.secondary">Loading Agents…</Typography>
      ) : null}
      {selectedOption ? (
        <TriggersPane
          key={selectedOption.agent.id}
          agent={selectedOption.agent}
          fixedConversationId={selectedOption.conversationId}
          initialCreateOpen
          createOnly
          onTriggerCreated={() =>
            onCreated(selectedOption.project.id, selectedOption.agent.id)}
          onCancelCreate={onCancel}
        />
      ) : (
        <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
          <Button onClick={onCancel}>Cancel</Button>
        </Stack>
      )}
    </Stack>
  );
}

export function CreateWorkspace({
  route,
  projects,
  engines,
  preferences,
  onCancel,
  onNavigate,
}: {
  route: Extract<Route, { kind: "create" }>;
  projects: ProjectDto[];
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onCancel(): void;
  onNavigate(route: Route): void;
}): JSX.Element {
  return (
    <CreateSurface route={route}>
      {route.resource === "project" ? (
        <ProjectCreateForm
          engines={engines}
          preferences={preferences}
          onCancel={onCancel}
          onCreated={project => onNavigate({ kind: "project", projectId: project.id })}
        />
      ) : route.resource === "chat" ? (
        <ChatCreateForm
          projects={projects}
          initialProjectId={route.projectId}
          onCancel={onCancel}
          onCreated={(projectId, conversationId) =>
            onNavigate({ kind: "conversation", projectId, conversationId })}
        />
      ) : route.resource === "agent" ? (
        <AgentCreateSurface
          projects={projects}
          engines={engines}
          initialProjectId={route.projectId}
          fixedProjectId={
            route.conversationId ? route.projectId : undefined
          }
          fixedConversationId={route.conversationId}
          initialManagerAgentId={route.managerAgentId}
          onCancel={onCancel}
          onCreated={(projectId, agent) =>
            onNavigate({ kind: "agent", projectId, agentId: agent.id })}
          onImported={(projectId, agentId) =>
            onNavigate({ kind: "agent", projectId, agentId })}
        />
      ) : (
        <TriggerCreateForm
          projects={projects}
          initialProjectId={route.projectId}
          initialConversationId={route.conversationId}
          initialAgentId={route.agentId}
          onCancel={onCancel}
          onCreated={(projectId, agentId) =>
            onNavigate({ kind: "agent", projectId, agentId, view: "triggers" })}
        />
      )}
    </CreateSurface>
  );
}
