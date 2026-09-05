import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CloseIcon from "@mui/icons-material/Close";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  IconButton,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
  createFilterOptions,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type {
  AgentDto,
  EngineDto,
  ProjectDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { api } from "../api";
import {
  engineUnavailableReason,
  engineIsAvailable,
  resolveRuntimeSelection,
  soleAvailableEngineId,
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
import { MobileNavigationButton } from "./MobileNavigationContext";
import { ProjectRuntimeFields } from "./ProjectRuntimeFields";
import { ProviderAvailabilityAlerts } from "./ProviderAvailabilityAlerts";
import { TriggersPane } from "./TriggersPane";
import { AgentCreateSurface } from "./AgentCreateDialog";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";

const anchoredCreationActionsSx = {
  position: "absolute",
  zIndex: 2,
  bottom: 0,
  left: 0,
  right: 0,
  justifyContent: "flex-end",
  px: { xs: 2, sm: 3 },
  py: 1.5,
  bgcolor: "background.paper",
  borderTop: 1,
  borderColor: "divider",
} as const;
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
    title: "Create Automation",
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
        <Stack direction="row" spacing={1} sx={{ minWidth: 0, mb: 2.5, alignItems: "flex-start" }}>
          <MobileNavigationButton />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <IconTitle icon={presentation.icon} title={presentation.title} component="h1" />
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              {presentation.description}
            </Typography>
          </Box>
          <PrimaryHeaderActionsOutlet />
        </Stack>
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
  anchoredActions = false,
}: {
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onCancel(): void;
  onCreated(project: ProjectDto): void;
  anchoredActions?: boolean;
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
  useEffect(() => {
    setDefaultEngine(current => current || soleAvailableEngineId(engines) || "");
  }, [engines]);
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
      if (updated.intakeReady) setDefaultEngine(updated.id);
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
                {engine.displayName}{engineIsAvailable(engine) ? "" : ` — ${engineUnavailableReason(engine)}`}
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
        <ProviderAvailabilityAlerts
          engines={engines}
          testPending={recheckEngine.isPending}
          onTestAccess={setEngineToTest}
        />
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
        <Stack
          direction="row"
          spacing={1}
          sx={anchoredActions ? anchoredCreationActionsSx : { justifyContent: "flex-end" }}
        >
          <Button disabled={createProject.isPending} onClick={onCancel}>Cancel</Button>
          <Button
            variant="contained"
            disabled={
              !engineIsAvailable(selectedEngine) ||
              projectCreationDisabled({ label, mode: folderMode, existingPath: path, defaultEngine, pending: createProject.isPending })
            }
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
  anchoredActions = false,
}: {
  projects: ProjectDto[];
  initialProjectId?: string;
  onCancel(): void;
  onCreated(projectId: string, conversationId: string): void;
  anchoredActions?: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState(
    projects.some(project => project.id === initialProjectId)
      ? initialProjectId!
      : projects[0]?.id ?? "",
  );
  useEffect(() => {
    if (!projects.length) return;
    setProjectId(current => {
      if (projects.some(project => project.id === current)) return current;
      if (initialProjectId && projects.some(project => project.id === initialProjectId)) {
        return initialProjectId;
      }
      return projects[0]!.id;
    });
  }, [initialProjectId, projects]);
  const create = useMutation({
    mutationFn: () => api.createConversation(projectId, { title: "New Chat" }),
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
      <Stack
        direction="row"
        spacing={1}
        sx={anchoredActions ? anchoredCreationActionsSx : { justifyContent: "flex-end" }}
      >
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
  anchoredActions = false,
}: {
  projects: ProjectDto[];
  initialProjectId?: string;
  initialConversationId?: string;
  initialAgentId?: string;
  onCancel(): void;
  onCreated(projectId: string, agentId: string, triggerId: string): void;
  anchoredActions?: boolean;
}): JSX.Element {
  const agentQueries = useProjectAgents(projects);
  const conversationQueries = useProjectConversations(projects);
  const [projectId, setProjectId] = useState(
    projects.some(project => project.id === initialProjectId)
      ? initialProjectId!
      : projects[0]?.id ?? "",
  );
  useEffect(() => {
    if (!projects.length) return;
    setProjectId(current => {
      if (projects.some(project => project.id === current)) return current;
      if (initialProjectId && projects.some(project => project.id === initialProjectId)) {
        return initialProjectId;
      }
      return projects[0]!.id;
    });
  }, [initialProjectId, projects]);
  const selectedProjectIndex = projects.findIndex(project => project.id === projectId);
  const chats = selectedProjectIndex >= 0
    ? (conversationQueries[selectedProjectIndex]?.data ?? []).filter(chat => !chat.deletedAt && !chat.archived)
    : [];
  const [conversationId, setConversationId] = useState(initialConversationId ?? "");
  useEffect(() => {
    setConversationId(current => {
      if (chats.some(chat => chat.id === current)) return current;
      if (initialConversationId && chats.some(chat => chat.id === initialConversationId)) {
        return initialConversationId;
      }
      return chats[0]?.id ?? "";
    });
  }, [initialConversationId, projectId, chats.map(chat => chat.id).join(":")]);
  const options = projects
    .flatMap((project, index) => {
      if (project.id !== projectId) return [];
      const chats = conversationQueries[index]?.data ?? [];
      return (agentQueries[index]?.data ?? []).flatMap(agent => {
        if (agent.archived) return [];
        if (agent.conversationId !== conversationId) return [];
        const chat = chats.find(candidate => candidate.id === agent.conversationId);
        return [{
          project,
          agent,
          conversationId: agent.conversationId,
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
      <FormControl fullWidth>
        <InputLabel id="create-automation-project-label">Project</InputLabel>
        <Select
          autoFocus
          labelId="create-automation-project-label"
          label="Project"
          value={projectId}
          onChange={event => setProjectId(event.target.value)}
        >
          {projects.map(project => (
            <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl fullWidth>
        <InputLabel id="create-automation-chat-label">Destination Chat</InputLabel>
        <Select
          labelId="create-automation-chat-label"
          label="Destination Chat"
          value={conversationId}
          onChange={event => setConversationId(event.target.value)}
        >
          {chats.map(chat => <MenuItem key={chat.id} value={chat.id}>{chat.title}</MenuItem>)}
        </Select>
      </FormControl>
      <Autocomplete
          fullWidth
          options={options}
          value={selectedOption ?? null}
          onChange={(_event, value) => setAgentId(value?.agent.id ?? "")}
          filterOptions={filterTriggerAgents}
          getOptionLabel={option =>
            option.agent.title}
          isOptionEqualToValue={(option, value) =>
            option.agent.id === value.agent.id}
          noOptionsText="No Automation-ready Agents found"
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
          projectId={selectedOption.project.id}
          agents={[selectedOption.agent]}
          initialTargetAgentId={selectedOption.agent.id}
          fixedTargetAgentId={selectedOption.agent.id}
          fixedConversationId={selectedOption.conversationId}
          initialCreateOpen
          createOnly
          stickyCreateActions={anchoredActions}
          onTriggerCreated={trigger =>
            onCreated(selectedOption.project.id, selectedOption.agent.id, trigger.id)}
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
  return <CreateSurface route={route}>
    <CreateFormContent
      route={route}
      projects={projects}
      engines={engines}
      preferences={preferences}
      onCancel={onCancel}
      onNavigate={onNavigate}
    />
  </CreateSurface>;
}

export type CreationRequest = Omit<
  Extract<Route, { kind: "create" }>,
  "kind" | "surface"
>;

function CreateFormContent({
  route,
  projects,
  engines,
  preferences,
  onCancel,
  onNavigate,
  onDirty,
  onPendingChange,
  anchoredActions = false,
}: {
  route: Extract<Route, { kind: "create" }>;
  projects: ProjectDto[];
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onCancel(): void;
  onNavigate(route: Route): void;
  onDirty?(): void;
  onPendingChange?(pending: boolean): void;
  anchoredActions?: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const refresh = (kind: "project" | "conversation" | "agent" | "trigger") => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind(kind) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceResourceRecency.all });
  };
  const content = route.resource === "project" ? (
    <ProjectCreateForm
      engines={engines}
      preferences={preferences}
      onCancel={onCancel}
      onCreated={project => {
        refresh("project");
        onNavigate({ kind: "project", projectId: project.id });
      }}
      anchoredActions={anchoredActions}
    />
  ) : route.resource === "chat" ? (
    <ChatCreateForm
      projects={projects}
      initialProjectId={route.projectId}
      onCancel={onCancel}
      onCreated={(projectId, conversationId) => {
        refresh("conversation");
        refresh("project");
        onNavigate({ kind: "conversation", projectId, conversationId });
      }}
      anchoredActions={anchoredActions}
    />
  ) : route.resource === "agent" ? (
    <AgentCreateSurface
      projects={projects}
      engines={engines}
      initialProjectId={route.projectId}
      fixedConversationId={route.conversationId}
      initialManagerAgentId={route.managerAgentId}
      stickyActions={anchoredActions}
      onPendingChange={onPendingChange}
      onCancel={onCancel}
      onCreated={(projectId, agent) => {
        refresh("agent");
        refresh("project");
        onNavigate({ kind: "agent", projectId, agentId: agent.id });
      }}
      onImported={(projectId, agentId) => {
        refresh("agent");
        refresh("project");
        onNavigate({ kind: "agent", projectId, agentId });
      }}
    />
  ) : (
    <TriggerCreateForm
      projects={projects}
      initialProjectId={route.projectId}
      initialConversationId={route.conversationId}
      initialAgentId={route.agentId}
      anchoredActions={anchoredActions}
      onCancel={onCancel}
      onCreated={(projectId, _agentId, triggerId) => {
        refresh("trigger");
        refresh("agent");
        onNavigate({ kind: "automation", projectId, triggerId });
      }}
    />
  );
  return (
    <Box
      onChangeCapture={onDirty}
      onInputCapture={onDirty}
      sx={{ minWidth: 0 }}
    >
      {content}
    </Box>
  );
}

export function ContextualCreateDialog({
  request,
  projects,
  engines,
  preferences,
  onClose,
  onNavigate,
}: {
  request?: CreationRequest;
  projects: ProjectDto[];
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onClose(): void;
  onNavigate(route: Route): void;
}): JSX.Element {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (request) {
      setDirty(false);
      setConfirmDiscard(false);
      setPending(false);
    }
  }, [request?.resource, request?.projectId, request?.conversationId, request?.agentId, request?.managerAgentId]);
  const route = request
    ? { kind: "create" as const, ...request, surface: "workspace" as const }
    : undefined;
  const close = () => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };
  const title = route ? resourcePresentation[route.resource].title : "Create";
  const icon = route ? resourcePresentation[route.resource].icon : null;
  return (
    <>
      <Dialog
        open={Boolean(route)}
        onClose={close}
        disableEscapeKeyDown={pending}
        fullScreen={fullScreen}
        fullWidth
        maxWidth={route?.resource === "agent" || route?.resource === "trigger" ? "md" : "sm"}
        aria-labelledby="contextual-create-title"
        slotProps={{
          paper: {
            sx: {
              position: "relative",
              maxHeight: fullScreen ? "100dvh" : "min(90dvh, 900px)",
              display: "grid",
              gridTemplateRows: "auto minmax(0, 1fr)",
            },
          },
        }}
      >
        <Box sx={{ position: "relative" }}>
          <DialogTitle id="contextual-create-title" sx={{ pr: 7 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              {icon}
              <Typography component="span" variant="h6" fontWeight={800}>
                {title}
              </Typography>
            </Stack>
          </DialogTitle>
          <IconButton
            aria-label={`Close ${title}`}
            disabled={pending}
            onClick={close}
            sx={{ position: "absolute", right: 12, top: 12 }}
          >
            <CloseIcon />
          </IconButton>
        </Box>
        <DialogContent
          className="ponderosa-scroll"
          sx={{
            minHeight: 0,
            overflowY: "auto",
            pt: "12px !important",
            pb: `max(96px, calc(72px + env(safe-area-inset-bottom)))`,
          }}
        >
          {route ? (
            <CreateFormContent
              key={[route.resource, route.projectId ?? "", route.conversationId ?? "", route.agentId ?? "", route.managerAgentId ?? ""].join(":")}
              route={route}
              projects={projects}
              engines={engines}
              preferences={preferences}
              onCancel={close}
              onDirty={() => setDirty(true)}
              onPendingChange={setPending}
              anchoredActions
              onNavigate={next => {
                setDirty(false);
                onClose();
                onNavigate(next);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title={`Discard this unfinished ${route ? resourcePresentation[route.resource].title.replace("Create ", "") : "item"}?`}
        confirmLabel="Discard and Close"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          setDirty(false);
          onClose();
        }}
      >
        <Typography sx={{ pt: 1 }}>Your entered information will be lost.</Typography>
      </ConfirmDialog>
    </>
  );
}
