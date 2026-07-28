import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { DestructiveConfirmDialog } from "./ConfirmationDialogs";

export function ProjectSettingsPanel({
  project,
  onDeleted,
}: {
  project: ProjectDto;
  onDeleted(projectId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(project.label);
  const [instructions, setInstructions] = useState(
    project.instructions ?? "",
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLabel(project.label);
    setInstructions(project.instructions ?? "");
    setDeleteOpen(false);
    setSaved(false);
  }, [project.id]);

  const updateProject = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        label: label.trim(),
        instructions,
      }),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      setDeleteOpen(false);
      onDeleted(project.id);
    },
  });

  return (
    <>
      <Box component="section" aria-label="Project Settings" sx={{ p: { xs: 1.5, sm: 3 } }}>
        <Stack
          spacing={2}
          sx={{ width: "100%", maxWidth: 720, mx: "auto" }}
        >
          <Box>
            <Typography variant="h5" component="h2" fontWeight={800}>
              Project Settings
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Manage this Project’s name, Agent rules, and lifecycle.
            </Typography>
          </Box>
          <TextField
            label="Project name"
            value={label}
            onChange={event => {
              setLabel(event.target.value);
              setSaved(false);
            }}
            fullWidth
          />
          <TextField
            label="Project master rules"
            value={instructions}
            onChange={event => {
              setInstructions(event.target.value);
              setSaved(false);
            }}
            multiline
            minRows={5}
            helperText="These rules apply after global rules to every Agent working in this Project."
            fullWidth
          />
          {updateProject.isError ? (
            <Alert severity="error">{String(updateProject.error)}</Alert>
          ) : null}
          {saved ? (
            <Alert severity="success">Project settings saved.</Alert>
          ) : null}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <Button
              variant="contained"
              disabled={!label.trim() || updateProject.isPending}
              onClick={() => updateProject.mutate()}
            >
              {updateProject.isPending ? "Saving…" : "Save Changes"}
            </Button>
            <Button
              color="error"
              variant="outlined"
              onClick={() => setDeleteOpen(true)}
            >
              Delete Project Permanently
            </Button>
          </Stack>
        </Stack>
      </Box>
      <DestructiveConfirmDialog
        open={deleteOpen}
        title="Delete this project?"
        confirmLabel="Delete Permanently"
        pendingLabel="Deleting…"
        pending={deleteProject.isPending}
        error={
          deleteProject.isError ? String(deleteProject.error) : undefined
        }
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteProject.mutate()}
      >
        <Alert severity="warning" sx={{ mt: 1 }}>
          This permanently deletes its Project chats, agents, runs, work items,
          and files &amp; results. The working folder and its source files are
          not deleted.
        </Alert>
      </DestructiveConfirmDialog>
    </>
  );
}

export function ProjectSettingsDialog({
  project,
  onClose,
  onDeleted,
}: {
  project?: ProjectDto;
  onClose(): void;
  onDeleted(projectId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!project) return;
    setLabel(project.label);
    setInstructions(project.instructions ?? "");
    setDeleteOpen(false);
  }, [project?.id]);

  const updateProject = useMutation({
    mutationFn: () => api.updateProject(project!.id, {
      label: label.trim(),
      instructions,
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
            <TextField
              label="Project master rules"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              multiline
              minRows={5}
              helperText="These rules apply after global rules to every Agent working in this Project."
              fullWidth
            />
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
    </>
  );
}
