import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
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
import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { effortOptionsForModel, engineIsAvailable, resolveRuntimeSelection } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { DestructiveConfirmDialog } from "./ConfirmationDialogs";
import { ImportAgentDialog } from "./ImportAgentDialog";

export function ProjectSettingsDialog({
  project,
  engines,
  preferences,
  onClose,
  onDeleted,
  onImported,
}: {
  project?: ProjectDto;
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onClose(): void;
  onDeleted(projectId: string): void;
  onImported(projectId: string, agentId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [defaultEngine, setDefaultEngine] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [defaultEffort, setDefaultEffort] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!project) return;
    setLabel(project.label);
    setInstructions(project.instructions ?? "");
    setDefaultEngine(project.defaultEngine);
    setDefaultModel(project.defaultModel ?? "");
    setDefaultEffort(project.defaultEffort ?? "");
    setDeleteOpen(false);
  }, [project]);

  const conversations = useQuery({
    queryKey: queryKeys.conversations.project(project?.id),
    queryFn: () => api.listConversations(project!.id),
    enabled: importOpen && Boolean(project),
    staleTime: 10_000,
  });
  const updateProject = useMutation({
    mutationFn: () => api.updateProject(project!.id, {
      label: label.trim(),
      instructions,
      defaultEngine,
      defaultModel: defaultModel || null,
      defaultEffort: defaultEffort || null,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      onClose();
    },
  });
  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(project!.id),
    onSuccess: () => {
      const projectId = project!.id;
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      setDeleteOpen(false);
      onDeleted(projectId);
    },
  });

  const engine = engines.find((candidate) => candidate.id === defaultEngine);
  const inherited = resolveRuntimeSelection(engine, preferences);
  const model = defaultModel || inherited.model;
  const efforts = effortOptionsForModel(engine, model);

  return (
    <>
      <Dialog
        open={Boolean(project)}
        onClose={updateProject.isPending ? undefined : onClose}
        fullWidth
        maxWidth="sm"
        aria-busy={updateProject.isPending || undefined}
      >
        <DialogTitle>Project Settings</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField autoFocus label="Project name" value={label} onChange={(event) => setLabel(event.target.value)} fullWidth />
            <FormControl fullWidth>
              <InputLabel id="settings-project-engine-label">Default engine</InputLabel>
              <Select
                labelId="settings-project-engine-label"
                label="Default engine"
                value={defaultEngine}
                onChange={(event) => {
                  setDefaultEngine(event.target.value);
                  setDefaultModel("");
                  setDefaultEffort("");
                }}
              >
                {engines.map((candidate) => <MenuItem key={candidate.id} value={candidate.id} disabled={!engineIsAvailable(candidate)}>{candidate.displayName}</MenuItem>)}
              </Select>
            </FormControl>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <FormControl fullWidth>
                <InputLabel id="settings-project-model-label">Project model</InputLabel>
                <Select
                  labelId="settings-project-model-label"
                  label="Project model"
                  value={defaultModel}
                  onChange={(event) => {
                    setDefaultModel(event.target.value);
                    setDefaultEffort("");
                  }}
                >
                  <MenuItem value="">Use Workspace Setting — {engine?.models.find((option) => option.id === inherited.model)?.label ?? inherited.model}</MenuItem>
                  {(engine?.models ?? []).filter((option) => option.id).map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="settings-project-effort-label">Project effort</InputLabel>
                <Select labelId="settings-project-effort-label" label="Project effort" value={defaultEffort} onChange={(event) => setDefaultEffort(event.target.value)}>
                  <MenuItem value="">Use Workspace Setting — {efforts.find((option) => option.id === inherited.effort)?.label ?? inherited.effort}</MenuItem>
                  {efforts.map((option) => <MenuItem key={option.id} value={option.id}>{option.label}</MenuItem>)}
                </Select>
              </FormControl>
            </Stack>
            <TextField
              label="Project master rules"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              multiline
              minRows={5}
              helperText="These rules apply after global rules to every Agent working in this Project."
              fullWidth
            />
            <Button
              variant="outlined"
              startIcon={<FileUploadOutlinedIcon />}
              onClick={() => setImportOpen(true)}
            >
              Import Agent or Organization
            </Button>
            {updateProject.isError ? <Alert severity="error">{String(updateProject.error)}</Alert> : null}
            <Button color="error" variant="outlined" onClick={() => setDeleteOpen(true)}>Delete Project Permanently</Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={updateProject.isPending} onClick={onClose}>Cancel</Button>
          <Button
            autoFocus
            variant="contained"
            disabled={!label.trim() || updateProject.isPending}
            onClick={() => updateProject.mutate()}
          >
            {updateProject.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
      <DestructiveConfirmDialog
        open={deleteOpen}
        title="Delete this project?"
        confirmLabel="Delete Permanently"
        pendingLabel="Deleting…"
        pending={deleteProject.isPending}
        error={deleteProject.isError ? String(deleteProject.error) : undefined}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteProject.mutate()}
      >
        <Alert severity="warning" sx={{ mt: 1 }}>
          This permanently deletes its Project chats, agents, runs, work items, and files &amp; results. The working folder and its source files are not deleted.
        </Alert>
      </DestructiveConfirmDialog>
      {project ? (
        <ImportAgentDialog
          open={importOpen}
          projectId={project.id}
          engines={engines}
          conversations={conversations.data ?? []}
          onClose={() => setImportOpen(false)}
          onImported={(agentId) => {
            setImportOpen(false);
            onImported(project.id, agentId);
          }}
        />
      ) : null}
    </>
  );
}
