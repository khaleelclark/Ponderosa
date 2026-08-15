import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import {
  engineIsAvailable,
  resolveRuntimeSelection,
} from "../conversationEngine";
import {
  createProjectRequest,
  projectCreationDisabled,
  type ProjectFolderMode,
} from "../projectLifecycle";
import { queryKeys } from "../queryKeys";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { HostFolderPicker } from "./HostFolderPicker";
import { ProjectRuntimeFields } from "./ProjectRuntimeFields";
import { ProviderAvailabilityAlerts } from "./ProviderAvailabilityAlerts";

export function ProjectCreationDialog({
  open,
  onboarding = false,
  engines,
  preferences,
  onClose,
  onCreated,
}: {
  open: boolean;
  onboarding?: boolean;
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onClose(): void;
  onCreated(project: ProjectDto, onboarding: boolean): void;
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
    if (!open) return;
    setLabel("");
    setPath("");
    setFolderMode("none");
    setDefaultEngine("");
    setDefaultModel("");
    setDefaultEffort("");
    setEngineToTest(undefined);
  }, [open]);

  const createProject = useMutation({
    mutationFn: () => api.createProject(createProjectRequest({
      label,
      mode: folderMode,
      existingPath: path,
      defaultEngine: defaultEngine as ProjectDto["defaultEngine"],
      defaultModel,
      defaultEffort,
    })),
    onSuccess: (project) => {
      queryClient.setQueryData<ProjectDto[]>(queryKeys.projects.all, (current = []) =>
        current.some((item) => item.id === project.id) ? current : [...current, project]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      onCreated(project, onboarding);
    },
  });

  const recheckEngine = useMutation({
    mutationFn: (engineId: string) => api.recheckEngine(engineId),
    onSuccess: (updated) => {
      queryClient.setQueryData<EngineDto[]>(queryKeys.engines.all, (current) =>
        current?.map((candidate) => candidate.id === updated.id ? updated : candidate));
      void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all });
      if (updated.intakeReady) setDefaultEngine(updated.id);
      setEngineToTest(undefined);
    },
  });

  const selectedEngine = engines.find((candidate) => candidate.id === defaultEngine);
  const inherited = resolveRuntimeSelection(selectedEngine, preferences);

  return (
    <>
      <Dialog
        open={open}
        onClose={createProject.isPending ? undefined : onClose}
        fullWidth
        maxWidth="sm"
        aria-busy={createProject.isPending || undefined}
      >
        <DialogTitle>{onboarding ? "Welcome to Ponderosa" : "New Project"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {onboarding ? <Alert severity="info">Create your first Project to start prompting. You can change these choices later in Project Settings.</Alert> : null}
            <TextField label="Project Name" value={label} onChange={(event) => setLabel(event.target.value)} autoFocus fullWidth />
            <Box>
              <Typography variant="subtitle2">Default AI Runtime</Typography>
              <Typography variant="body2" color="text.secondary">Choose the provider for this Project. Chats and Agents can override its model and reasoning later.</Typography>
            </Box>
            <FormControl fullWidth>
              <InputLabel shrink id="project-default-engine-label">AI Provider</InputLabel>
              <Select
                labelId="project-default-engine-label"
                label="AI Provider"
                value={defaultEngine}
                displayEmpty
                onChange={(event) => {
                  setDefaultEngine(event.target.value);
                  setDefaultModel("");
                  setDefaultEffort("");
                }}
              >
                <MenuItem value="" disabled>Select a Provider</MenuItem>
                {engines.map((engine) => (
                  <MenuItem key={engine.id} value={engine.id} disabled={!engineIsAvailable(engine)}>
                    {engine.displayName}{engineIsAvailable(engine) ? "" : engine.authentication === "checking" ? " — Checking" : engine.authentication === "authenticated" ? " — Unavailable" : " — Not Signed In"}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <ProjectRuntimeFields
              engine={selectedEngine}
              inherited={inherited}
              model={defaultModel}
              effort={defaultEffort}
              onChange={(selection) => {
                setDefaultModel(selection.model);
                setDefaultEffort(selection.effort);
              }}
              modelLabel="Model"
              effortLabel="Reasoning"
              modelLabelId="project-default-model-label"
              effortLabelId="project-default-effort-label"
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
              <RadioGroup value={folderMode} onChange={(event) => {
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
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={createProject.isPending} onClick={onClose}>{onboarding ? "Not Now" : "Cancel"}</Button>
          <Button
            autoFocus
            variant="contained"
            disabled={projectCreationDisabled({ label, mode: folderMode, existingPath: path, defaultEngine, pending: createProject.isPending })}
            onClick={() => createProject.mutate()}
          >
            {createProject.isPending ? "Creating…" : onboarding ? "Create Project and Continue" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
      <HostFolderPicker
        open={folderPickerOpen}
        initialPath={path || undefined}
        onClose={() => setFolderPickerOpen(false)}
        onChoose={(nextPath) => {
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
