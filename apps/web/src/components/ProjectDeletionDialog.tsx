import { Alert, Checkbox, FormControlLabel, Skeleton, Stack, Typography } from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";
import { useMutationNotification } from "./MutationNotifications";

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
  const [acknowledged, setAcknowledged] = useState(false);
  const notify = useMutationNotification();
  const preview = useQuery({
    queryKey: ["project-deletion-preview", project.id],
    queryFn: () => api.getProjectDeletionPreview(project.id),
    enabled: open,
    staleTime: 0,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: result => {
      notify(result.cleanupPending
        ? {
            key: `project-deleted:${project.id}`,
            message: `${project.label} was deleted. Filesystem cleanup is still running.`,
            severity: "warning",
            persistent: true,
          }
        : {
            key: `project-deleted:${project.id}`,
            message: `${project.label} was deleted.`,
          });
      onDeleted(project.id);
    },
  });

  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    remove.reset();
  // A newly opened dialog is a new confirmation attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);

  return (
    <ResourceDeletionDialog
      open={open}
      resourceType="Project"
      resourceName={project.label}
      confirmLabel="Delete Project"
      pendingLabel="Deleting…"
      pending={remove.isPending}
      confirmDisabled={preview.isLoading || preview.isError || Boolean(preview.data?.nonempty && !acknowledged)}
      error={remove.isError ? String(remove.error) : undefined}
      onCancel={() => {
        if (!remove.isPending) onClose();
      }}
      onConfirm={() => remove.mutate()}
    >
      <Alert severity="warning" sx={{ mb: 1.5 }}>
        This permanently deletes Ponderosa records for <strong>{project.label}</strong>.
        Active work is cancelled by the server. The Project Shared folder and
        its source files are preserved.
      </Alert>
      {preview.isLoading ? <Stack spacing={0.75} sx={{ mb: 1.5 }}><Skeleton /><Skeleton width="70%" /></Stack> : null}
      {preview.isError ? <Alert severity="error" sx={{ mb: 1.5 }}>The deletion impact could not be loaded. Close and try again.</Alert> : null}
      {preview.data ? (
        <Stack spacing={0.5} sx={{ mb: 1.5 }}>
          <Typography variant="body2">{preview.data.chats} Chats</Typography>
          <Typography variant="body2">{preview.data.agents} Agents</Typography>
          <Typography variant="body2">{preview.data.automations} Automations</Typography>
          <Typography variant="body2">{preview.data.managedFiles} managed Project Files</Typography>
          {preview.data.activeAgents.length ? (
            <Alert severity="warning">
              Active work from {preview.data.activeAgents.map(agent => agent.title).join(", ")} will be cancelled.
            </Alert>
          ) : null}
          {preview.data.projectBrowserActive ? <Typography variant="body2">The active Project Browser will be closed.</Typography> : null}
        </Stack>
      ) : null}
      {preview.data?.nonempty ? <FormControlLabel
        control={
          <Checkbox
            autoFocus
            checked={acknowledged}
            onChange={event => setAcknowledged(event.target.checked)}
          />
        }
        label="I understand that this cannot be undone."
      /> : null}
    </ResourceDeletionDialog>
  );
}
