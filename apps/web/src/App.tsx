import AddIcon from "@mui/icons-material/Add";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import LightModeIcon from "@mui/icons-material/LightMode";
import SettingsIcon from "@mui/icons-material/Settings";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { ProjectShell } from "./components/ProjectShell";
import { TokenUsageButton } from "./components/TokenUsageButton";
import { useEngines, useProjectFolders, useProjects } from "./hooks/queries";
import {
  loadLastProjectId,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";
import type { ColorMode } from "./theme";
import { createProjectRequest, nextProjectAfterDelete, projectCreationDisabled, type ProjectFolderMode } from "./projectLifecycle";

function ProjectTabs({
  projects,
  selectedProjectId,
  onSelect,
  onCreate,
  onManage,
}: {
  projects: ProjectDto[];
  selectedProjectId: string | undefined;
  onSelect(projectId: string): void;
  onCreate(): void;
  onManage(): void;
}): JSX.Element {
  return (
    <Stack direction="row" sx={{ alignItems: "center", borderBottom: 1, borderColor: "divider" }}>
      <FormControl size="small" sx={{ display: { xs: "flex", sm: "none" }, flex: 1, minWidth: 0, ml: 1 }}>
        <Select
          aria-label="Project"
          value={projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : ""}
          displayEmpty
          onChange={(event) => onSelect(event.target.value)}
        >
          {projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}
        </Select>
      </FormControl>
      <Tabs
        value={projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : false}
        onChange={(_event, value: string) => onSelect(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 48, flex: 1, minWidth: 0, display: { xs: "none", sm: "flex" } }}
      >
        {projects.map((project) => (
          <Tab
            key={project.id}
            value={project.id}
            icon={<FolderOpenIcon />}
            iconPosition="start"
            label={project.label}
            sx={{ minHeight: 48 }}
          />
        ))}
      </Tabs>
      {selectedProjectId ? <TokenUsageButton scope="project" scopeId={selectedProjectId} label="Project" /> : null}
      <Tooltip title="New project">
        <IconButton onClick={onCreate} aria-label="New project" sx={{ mx: 1 }}>
          <AddIcon />
        </IconButton>
      </Tooltip>
      {selectedProjectId ? <Tooltip title="Project settings"><IconButton onClick={onManage} aria-label="Project settings" sx={{ mr: 1 }}><SettingsIcon /></IconButton></Tooltip> : null}
    </Stack>
  );
}

export default function App({
  colorMode,
  onToggleColorMode,
}: {
  colorMode: ColorMode;
  onToggleColorMode(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { route, navigate } = useRoute();
  const projectsQuery = useProjects();
  const enginesQuery = useEngines();
  const projects = projectsQuery.data ?? [];
  const engines = enginesQuery.data ?? [];

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectLabel, setProjectLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectFolderMode, setProjectFolderMode] = useState<ProjectFolderMode>("automatic");
  const [projectFolderName, setProjectFolderName] = useState("");
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [renamedProjectLabel, setRenamedProjectLabel] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const projectFoldersQuery = useProjectFolders(projectDialogOpen);

  const routedProjectId = routeProjectId(route);
  const selectedProjectId =
    routedProjectId && projects.some((project) => project.id === routedProjectId)
      ? routedProjectId
      : undefined;

  // Land on a concrete project: honour the URL, else the last-used project, else
  // the first available. Uses replace so the initial redirect isn't a history step.
  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    if (selectedProjectId) {
      saveLastProjectId(selectedProjectId);
      return;
    }
    const preferred = loadLastProjectId();
    const target = projects.find((project) => project.id === preferred) ?? projects[0];
    if (target) {
      navigate({ kind: "project", projectId: target.id }, { replace: true });
    }
  }, [projects, selectedProjectId, navigate]);

  const createProject = useMutation({
    mutationFn: () =>
      api.createProject(createProjectRequest({ label: projectLabel, mode: projectFolderMode, existingPath: projectPath, newFolderName: projectFolderName })),
    onSuccess: (project) => {
      queryClient.setQueryData<ProjectDto[]>(["projects"], (current = []) =>
        current.some((item) => item.id === project.id) ? current : [...current, project],
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectDialogOpen(false);
      setProjectLabel("");
      setProjectPath("");
      setProjectFolderName("");
      setProjectFolderMode("automatic");
      navigate({ kind: "project", projectId: project.id });
    },
  });

  const updateProject = useMutation({
    mutationFn: () => api.updateProject(selectedProjectId!, { label: renamedProjectLabel.trim() }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); setProjectSettingsOpen(false); },
  });

  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(selectedProjectId!),
    onSuccess: () => {
      const next = nextProjectAfterDelete(projects, selectedProjectId!);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setDeleteConfirmationOpen(false);
      setProjectSettingsOpen(false);
      if (next) { saveLastProjectId(next.id); navigate({ kind: "project", projectId: next.id }); }
      else navigate({ kind: "home" });
    },
  });

  const selectProject = (projectId: string) => {
    saveLastProjectId(projectId);
    navigate({ kind: "project", projectId });
  };

  const goHome = (next: Route) => navigate(next);

  return (
    <Box
      data-testid="ponderosa-app"
      sx={{
        height: "100dvh",
        width: "100%",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        bgcolor: "background.default",
      }}
    >
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: { xs: 52, sm: 56 }, px: { xs: 1.5, sm: 3 }, pt: "env(safe-area-inset-top)" }}>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 800, flex: 1, minWidth: 0 }} noWrap>
            Ponderosa
          </Typography>
          <Chip
            size="small"
            label={engines.some((engine) => engine.authenticated) ? "Engine ready" : "Engine auth needed"}
            color={engines.some((engine) => engine.authenticated) ? "success" : "warning"}
            variant="outlined"
            sx={{ maxWidth: { xs: 132, sm: "none" } }}
          />
          <Box sx={{ ml: 1, display: { xs: "none", sm: "block" } }}>
            <TokenUsageButton scope="overall" label="Overall" />
          </Box>
          <Box sx={{ ml: 0.5, display: { xs: "block", sm: "none" } }}>
            <TokenUsageButton scope="overall" label="Overall" compact />
          </Box>
          <Tooltip title={colorMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            <IconButton
              aria-label={colorMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              onClick={onToggleColorMode}
              sx={{ ml: 0.5, minWidth: 44, minHeight: 44 }}
            >
              {colorMode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
            </IconButton>
          </Tooltip>
        </Toolbar>
        <ProjectTabs
          projects={projects}
          selectedProjectId={selectedProjectId}
          onCreate={() => setProjectDialogOpen(true)}
          onSelect={selectProject}
          onManage={() => {
            const selected = projects.find((project) => project.id === selectedProjectId);
            setRenamedProjectLabel(selected?.label ?? "");
            setProjectSettingsOpen(true);
          }}
        />
      </AppBar>

      <Box component="main" id="main-content" sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>
        {projectsQuery.isError || enginesQuery.isError ? (
          <Box sx={{ p: 2 }}>
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    void projectsQuery.refetch();
                    void enginesQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            >
              Ponderosa could not load its workspace data. Check the server connection and try again.
            </Alert>
          </Box>
        ) : projects.length === 0 && !projectsQuery.isLoading ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="info">Create a project to get started.</Alert>
          </Box>
        ) : selectedProjectId ? (
          <ProjectShell
            projectId={selectedProjectId}
            route={route}
            engines={engines}
            navigate={goHome}
          />
        ) : (
          <Box />
        )}
      </Box>

      <Dialog open={projectDialogOpen} onClose={() => setProjectDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Project</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Label"
              value={projectLabel}
              onChange={(event) => setProjectLabel(event.target.value)}
              autoFocus
              fullWidth
            />
            <FormControl fullWidth><InputLabel id="project-folder-mode-label">Working folder</InputLabel><Select labelId="project-folder-mode-label" label="Working folder" value={projectFolderMode} onChange={(event) => setProjectFolderMode(event.target.value as typeof projectFolderMode)}>
              <MenuItem value="automatic">Optional — create a managed folder automatically</MenuItem>
              <MenuItem value="existing">Choose an existing folder</MenuItem>
              <MenuItem value="create">Create a named empty folder</MenuItem>
            </Select></FormControl>
            {projectFolderMode === "existing" ? <>
              <FormControl fullWidth><InputLabel id="existing-project-folder-label">Registered or managed folder</InputLabel><Select labelId="existing-project-folder-label" label="Registered or managed folder" value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
                {(projectFoldersQuery.data?.folders ?? []).map((folder) => <MenuItem key={folder.hostPath} value={folder.hostPath}>{folder.name} — {folder.hostPath}</MenuItem>)}
              </Select></FormControl>
              <TextField label="Or enter an existing absolute path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/Users/you/Projects/app" fullWidth />
            </> : null}
            {projectFolderMode === "create" ? <TextField label="New folder name" value={projectFolderName} onChange={(event) => setProjectFolderName(event.target.value)} helperText={`Created inside ${projectFoldersQuery.data?.managedRoot ?? "the managed workspace"}`} fullWidth /> : null}
            {createProject.isError ? <Alert severity="error">{String(createProject.error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProjectDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={projectCreationDisabled({ label: projectLabel, mode: projectFolderMode, existingPath: projectPath, newFolderName: projectFolderName, pending: createProject.isPending })}
            onClick={() => createProject.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={projectSettingsOpen} onClose={() => setProjectSettingsOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Project settings</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Project name" value={renamedProjectLabel} onChange={(event) => setRenamedProjectLabel(event.target.value)} fullWidth />
          {updateProject.isError ? <Alert severity="error">{String(updateProject.error)}</Alert> : null}
          <Button color="error" variant="outlined" onClick={() => setDeleteConfirmationOpen(true)}>Delete project permanently</Button>
        </Stack></DialogContent><DialogActions><Button onClick={() => setProjectSettingsOpen(false)}>Cancel</Button><Button variant="contained" disabled={!renamedProjectLabel.trim() || updateProject.isPending} onClick={() => updateProject.mutate()}>Save</Button></DialogActions>
      </Dialog>

      <Dialog open={deleteConfirmationOpen} onClose={() => setDeleteConfirmationOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Delete this project?</DialogTitle><DialogContent><Alert severity="warning">This permanently deletes its Project chats, agents, runs, work items, and files &amp; results. The working folder and its source files are not deleted.</Alert>{deleteProject.isError ? <Alert severity="error" sx={{ mt: 2 }}>{String(deleteProject.error)}</Alert> : null}</DialogContent>
        <DialogActions><Button onClick={() => setDeleteConfirmationOpen(false)}>Cancel</Button><Button color="error" variant="contained" disabled={deleteProject.isPending} onClick={() => deleteProject.mutate()}>Delete permanently</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
