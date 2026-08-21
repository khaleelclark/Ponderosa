import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { EngineDto, ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { resolveRuntimeSelection } from "../conversationEngine";
import { queryKeys } from "../queryKeys";
import { EngineModelEffortFields } from "./ProjectRuntimeFields";
import { ProjectDeletionDialog } from "./ProjectDeletionDialog";

export function ProjectSettingsPanel({
  project,
  engines,
  preferences,
  onDeleted,
}: {
  project: ProjectDto;
  engines: EngineDto[];
  preferences: WorkspacePreferencesDto;
  onDeleted(projectId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(project.label);
  const [instructions, setInstructions] = useState(
    project.instructions ?? "",
  );
  const [runtimeEngineId, setRuntimeEngineId] = useState(project.defaultEngine);
  const [runtimeModel, setRuntimeModel] = useState(project.defaultModel ?? "");
  const [runtimeEffort, setRuntimeEffort] = useState(project.defaultEffort ?? "");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLabel(project.label);
    setInstructions(project.instructions ?? "");
    setRuntimeEngineId(project.defaultEngine);
    setRuntimeModel(project.defaultModel ?? "");
    setRuntimeEffort(project.defaultEffort ?? "");
    setDeleteOpen(false);
    setSaved(false);
  }, [project.id]);

  const updateProject = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        label: label.trim(),
        instructions,
        defaultEngine: runtimeEngineId,
        defaultModel: runtimeModel || null,
        defaultEffort: runtimeEffort || null,
      }),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
  const runtimeEngine = engines.find(engine => engine.id === runtimeEngineId);
  const effectiveRuntime = resolveRuntimeSelection(
    runtimeEngine,
    preferences,
    {
      defaultEngine: runtimeEngineId,
      ...(runtimeModel ? { defaultModel: runtimeModel } : {}),
      ...(runtimeEffort ? { defaultEffort: runtimeEffort } : {}),
    },
  );
  const effectiveModelLabel = runtimeEngine?.models.find(option =>
    option.id === effectiveRuntime.model
  )?.label ?? (effectiveRuntime.model || "Provider default");
  const effectiveEffortLabel = runtimeEngine?.efforts.find(option =>
    option.id === effectiveRuntime.effort
  )?.label ?? (effectiveRuntime.effort || "Provider default");
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
          <Box component="section" aria-labelledby="project-runtime-heading">
            <Stack spacing={1.5}>
              <Box>
                <Typography id="project-runtime-heading" variant="h6" fontWeight={800}>
                  Default AI Runtime
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Effective settings inherited by new Chats and Agents in this Project.
                </Typography>
              </Box>
              <FormControl fullWidth>
                <InputLabel id="project-runtime-provider-label">Provider</InputLabel>
                <Select
                  labelId="project-runtime-provider-label"
                  label="Provider"
                  value={runtimeEngineId}
                  onChange={event => {
                    setRuntimeEngineId(event.target.value);
                    setRuntimeModel("");
                    setRuntimeEffort("");
                    setSaved(false);
                  }}
                >
                  {engines.map(engine => (
                    <MenuItem key={engine.id} value={engine.id}>{engine.displayName}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <EngineModelEffortFields
                engine={runtimeEngine}
                selection={{ model: runtimeModel, effort: runtimeEffort }}
                optionSelection={effectiveRuntime}
                onChange={selection => {
                  setRuntimeModel(selection.model);
                  setRuntimeEffort(selection.effort);
                  setSaved(false);
                }}
                modelLabel="Model override"
                effortLabel="Reasoning override"
                modelEmptyLabel="Inherit workspace or provider default"
                effortEmptyLabel="Inherit model, workspace, or provider default"
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <Chip label={"Provider: " + (runtimeEngine?.displayName ?? runtimeEngineId) + " / Project setting"} />
                <Chip label={"Model: " + effectiveModelLabel + " / " + (runtimeModel ? "Project override" : "Inherited")} />
                <Chip label={"Reasoning: " + effectiveEffortLabel + " / " + (runtimeEffort ? "Project override" : "Inherited")} />
              </Stack>
            </Stack>
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
    </>
  );
}
