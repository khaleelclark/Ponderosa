import {
  Alert,
  Box,
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
  Typography,
} from "@mui/material";
import type {
  ProjectDto,
  ProviderPermissionSetting,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ProjectDeletionDialog } from "./ProjectDeletionDialog";

export function ProjectSettingsPanel({
  project,
  preferences,
  onDeleted,
}: {
  project: ProjectDto;
  preferences: WorkspacePreferencesDto;
  onDeleted(projectId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(project.label);
  const [instructions, setInstructions] = useState(
    project.instructions ?? "",
  );
  const [providerPermissionMode, setProviderPermissionMode] =
    useState<ProviderPermissionSetting>(project.providerPermissionMode);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [applyPermissionOpen, setApplyPermissionOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLabel(project.label);
    setInstructions(project.instructions ?? "");
    setProviderPermissionMode(project.providerPermissionMode);
    setDeleteOpen(false);
    setApplyPermissionOpen(false);
    setSaved(false);
  }, [project.id]);

  const updateProject = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        label: label.trim(),
        instructions,
        providerPermissionMode,
      }),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
  const applyProviderPermissionDefault = useMutation({
    mutationFn: () => api.applyProjectProviderPermissionDefault(project.id),
    onSuccess: () => {
      setApplyPermissionOpen(false);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all,
      });
    },
  });
  const workspacePermissionLabel =
    preferences.providerPermissionMode === "auto_confirmations"
      ? "Auto-approve confirmations"
      : "Ask for approval";
  const providerPermissionModeDirty =
    providerPermissionMode !== project.providerPermissionMode;
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
          <Box>
            <Typography variant="h6" fontWeight={800}>
              Provider Permissions
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              This is the default for Chats in this Project. Individual Chats
              can still override it from their composer.
            </Typography>
            <FormControl fullWidth>
              <InputLabel id="project-provider-permissions">
                Project default
              </InputLabel>
              <Select
                labelId="project-provider-permissions"
                label="Project default"
                value={providerPermissionMode}
                onChange={event => {
                  setProviderPermissionMode(
                    event.target.value as ProviderPermissionSetting,
                  );
                  applyProviderPermissionDefault.reset();
                  setSaved(false);
                }}
              >
                <MenuItem value="inherit">
                  Use workspace default ({workspacePermissionLabel})
                </MenuItem>
                <MenuItem value="ask">Ask for approval</MenuItem>
                <MenuItem value="auto_confirmations">
                  Auto-approve confirmations
                </MenuItem>
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              sx={{ mt: 1.5 }}
              disabled={providerPermissionModeDirty}
              onClick={() => setApplyPermissionOpen(true)}
            >
              Apply Project Default to Existing Chats
            </Button>
            {providerPermissionModeDirty ? (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.75 }}
              >
                Save the Project default before applying it to existing Chats.
              </Typography>
            ) : null}
            {applyProviderPermissionDefault.isSuccess ? (
              <Alert severity="success" sx={{ mt: 1.5 }}>
                {applyProviderPermissionDefault.data.updatedConversations
                  ? `Updated ${applyProviderPermissionDefault.data.updatedConversations} existing Chat${applyProviderPermissionDefault.data.updatedConversations === 1 ? "" : "s"}.`
                  : "All existing Chats already use the Project default."}
              </Alert>
            ) : null}
            {applyProviderPermissionDefault.isError ? (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {String(applyProviderPermissionDefault.error)}
              </Alert>
            ) : null}
          </Box>
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
      <Dialog
        open={applyPermissionOpen}
        onClose={() => setApplyPermissionOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Apply Project Default?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Every existing Chat in this Project will start inheriting the
            Project default. Any Chat-specific permission choice will be
            removed.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            color="inherit"
            disabled={applyProviderPermissionDefault.isPending}
            onClick={() => setApplyPermissionOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={applyProviderPermissionDefault.isPending}
            onClick={() => applyProviderPermissionDefault.mutate()}
          >
            {applyProviderPermissionDefault.isPending
              ? "Applying…"
              : "Apply to Existing Chats"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
