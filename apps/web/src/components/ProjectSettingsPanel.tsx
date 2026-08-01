import {
  Alert,
  Box,
  Button,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { ProjectDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ProjectDeletionDialog } from "./ProjectDeletionDialog";

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
      <ProjectDeletionDialog
        project={project}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={onDeleted}
      />
    </>
  );
}
