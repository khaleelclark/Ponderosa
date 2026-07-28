import { Alert, TextField, Typography } from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";

export function ProjectDeletionDialog({
  project,
  open,
  onClose,
  onDeleted,
}: {
  project: ProjectDto;
  open: boolean;
  onClose(): void;
  onDeleted(projectId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState("");
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      onDeleted(project.id);
    },
  });

  useEffect(() => {
    if (!open) return;
    setConfirmation("");
    remove.reset();
  // A newly opened dialog is a new confirmation attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);

  return (
    <ResourceDeletionDialog
      open={open}
      resourceType="Project"
      resourceName={project.label}
      confirmLabel="Delete Project Permanently"
      pendingLabel="Deleting…"
      pending={remove.isPending}
      confirmDisabled={confirmation !== project.label}
      error={remove.isError ? String(remove.error) : undefined}
      onCancel={() => {
        if (!remove.isPending) onClose();
      }}
      onConfirm={() => remove.mutate()}
    >
      <Alert severity="error" sx={{ mb: 2 }}>
        This permanently deletes the Project’s Chats, Agents, Triggers, Runs,
        work items, and Files &amp; Results. Active work is cancelled. The
        working folder and its source files are preserved.
      </Alert>
      <Typography variant="body2" sx={{ mb: 1 }}>
        Type <strong>{project.label}</strong> to confirm.
      </Typography>
      <TextField
        autoFocus
        fullWidth
        label="Project name"
        value={confirmation}
        onChange={event => setConfirmation(event.target.value)}
      />
    </ResourceDeletionDialog>
  );
}
