import AddIcon from "@mui/icons-material/Add";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
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
import { useEngines, useProjects } from "./hooks/queries";
import {
  loadLastProjectId,
  routeProjectId,
  saveLastProjectId,
  useRoute,
  type Route,
} from "./routing";

function ProjectTabs({
  projects,
  selectedProjectId,
  onSelect,
  onCreate,
}: {
  projects: ProjectDto[];
  selectedProjectId: string | undefined;
  onSelect(projectId: string): void;
  onCreate(): void;
}): JSX.Element {
  return (
    <Stack direction="row" sx={{ alignItems: "center", borderBottom: 1, borderColor: "divider" }}>
      <Tabs
        value={projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : false}
        onChange={(_event, value: string) => onSelect(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 48, flex: 1, minWidth: 0 }}
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
      <Tooltip title="New project">
        <IconButton onClick={onCreate} aria-label="New project" sx={{ mx: 1 }}>
          <AddIcon />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

export default function App(): JSX.Element {
  const queryClient = useQueryClient();
  const { route, navigate } = useRoute();
  const projectsQuery = useProjects();
  const enginesQuery = useEngines();
  const projects = projectsQuery.data ?? [];
  const engines = enginesQuery.data ?? [];

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectLabel, setProjectLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");

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
      api.createProject({ label: projectLabel.trim(), hostPath: projectPath.trim() }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectDialogOpen(false);
      setProjectLabel("");
      setProjectPath("");
      navigate({ kind: "project", projectId: project.id });
    },
  });

  const selectProject = (projectId: string) => {
    saveLastProjectId(projectId);
    navigate({ kind: "project", projectId });
  };

  const goHome = (next: Route) => navigate(next);

  return (
    <Box
      sx={{
        height: "100dvh",
        minHeight: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        bgcolor: "background.default",
      }}
    >
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: 56 }}>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 800, flex: 1 }}>
            Ponderosa
          </Typography>
          <Chip
            size="small"
            label={engines.some((engine) => engine.authenticated) ? "Engine ready" : "Engine auth needed"}
            color={engines.some((engine) => engine.authenticated) ? "success" : "warning"}
            variant="outlined"
          />
        </Toolbar>
        <ProjectTabs
          projects={projects}
          selectedProjectId={selectedProjectId}
          onCreate={() => setProjectDialogOpen(true)}
          onSelect={selectProject}
        />
      </AppBar>

      <Box sx={{ minHeight: 0, display: "grid" }}>
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
            <TextField
              label="Host path"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/Users/you/Projects/app"
              fullWidth
            />
            {createProject.isError ? <Alert severity="error">{String(createProject.error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProjectDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!projectLabel.trim() || !projectPath.trim() || createProject.isPending}
            onClick={() => createProject.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
