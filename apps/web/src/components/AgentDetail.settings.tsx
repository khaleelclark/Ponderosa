import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  FormControl,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Select,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AgentDto,
  AgentDetailDto,
  AgentWorkingCopyMode,
  AgentManagementPermissionsDto,
  BrowserProfileDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

function AgentWorkingCopySettings({ agent }: { agent: AgentDto }): JSX.Element {
  const queryClient = useQueryClient();
  const changeMode = useMutation({
    mutationFn: (workingCopyMode: AgentWorkingCopyMode) =>
      api.updateAgent(agent.id, { workingCopyMode }),
    onSuccess: updated => {
      queryClient.setQueryData<AgentDto[]>(
        queryKeys.agents.project(agent.projectId),
        current => current?.map(candidate => candidate.id === updated.id ? updated : candidate),
      );
      queryClient.setQueriesData<AgentDetailDto>(
        { queryKey: queryKeys.agents.detailPrefix(agent.id) },
        current => current ? { ...current, agent: updated } : current,
      );
    },
  });
  const workingCopy = changeMode.data?.id === agent.id
    ? changeMode.data.workingCopy
    : agent.workingCopy;
  const label = workingCopy.mode === "separate_git" ? "Separate Git copy" : "Shared folder";
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", mb: 0.75 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ flex: 1 }}>Working Folder</Typography>
        <Chip
          size="small"
          color={workingCopy.state === "ready" ? "success" : "error"}
          label={workingCopy.state === "ready" ? `${label} · Ready` : `${label} · Needs attention`}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Shared is best when Agents need to see each other's changes immediately. Separate Git gives this Agent its own branch and folder for code work.
      </Typography>
      <FormControl fullWidth size="small" disabled={changeMode.isPending}>
        <InputLabel id={`working-copy-${agent.id}`}>Working folder</InputLabel>
        <Select
          labelId={`working-copy-${agent.id}`}
          label="Working folder"
          value={workingCopy.mode}
          onChange={event => changeMode.mutate(event.target.value as AgentWorkingCopyMode)}
        >
          <MenuItem value="shared">Shared folder</MenuItem>
          <MenuItem value="separate_git">Separate Git copy</MenuItem>
        </Select>
      </FormControl>
      {workingCopy.mode === "separate_git" && workingCopy.state === "ready" ? (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          Changes stay on this Agent's Git branch{workingCopy.branch ? ` (${workingCopy.branch})` : ""}. This separates work; it does not limit what the Agent can access on the host.
        </Alert>
      ) : null}
      {workingCopy.state === "unavailable" ? (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {workingCopy.failure ?? "This working folder is unavailable."} Runs stay paused instead of using the Shared folder.
        </Alert>
      ) : null}
      {changeMode.error ? <Alert severity="error" sx={{ mt: 1.5 }}>{String(changeMode.error)}</Alert> : null}
    </Paper>
  );
}

function AgentBrowserProfileSettings({ agent }: { agent: AgentDto }): JSX.Element {
  const queryClient = useQueryClient();
  const [newProfileName, setNewProfileName] = useState("");
  const [profileToDelete, setProfileToDelete] = useState<BrowserProfileDto>();
  const profiles = useQuery({
    queryKey: queryKeys.agentBrowsers.profiles(agent.projectId),
    queryFn: () => api.listBrowserProfiles(agent.projectId),
  });
  const preference = useQuery({
    queryKey: queryKeys.agentBrowsers.preference(agent.projectId, agent.id),
    queryFn: () => api.getBrowserAgentPreference(agent.projectId, agent.id),
  });
  const updatePreference = useMutation({
    mutationFn: (value: string) => api.updateBrowserAgentPreference(
      agent.projectId,
      agent.id,
      value === "disposable" ? { mode: "disposable" } : { mode: "trusted", profileId: value },
    ),
    onSuccess: value => queryClient.setQueryData(
      queryKeys.agentBrowsers.preference(agent.projectId, agent.id),
      value,
    ),
  });
  const createProfile = useMutation({
    mutationFn: (name: string) => api.createBrowserProfile(agent.projectId, { name }),
    onSuccess: created => {
      setNewProfileName("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentBrowsers.profiles(agent.projectId) });
      updatePreference.mutate(created.id);
    },
  });
  const deleteProfile = useMutation({
    mutationFn: (profileId: string) => api.deleteBrowserProfile(agent.projectId, profileId),
    onSuccess: () => {
      setProfileToDelete(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentBrowsers.profiles(agent.projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentBrowsers.preference(agent.projectId, agent.id) });
    },
  });
  const selected = preference.data?.mode === "trusted" && preference.data.profileId
    ? preference.data.profileId
    : "disposable";
  const error = updatePreference.error ?? createProfile.error ?? deleteProfile.error ?? profiles.error ?? preference.error;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={800}>Hosted Browser</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Disposable profiles start clean. Trusted profiles retain cookies, logins, and site storage on this Ponderosa host and are leased to only one browser at a time.
      </Typography>
      <FormControl fullWidth size="small" disabled={preference.isLoading || updatePreference.isPending}>
        <InputLabel id={`browser-profile-${agent.id}`}>Browser profile</InputLabel>
        <Select
          labelId={`browser-profile-${agent.id}`}
          label="Browser profile"
          value={selected}
          onChange={event => updatePreference.mutate(event.target.value)}
        >
          <MenuItem value="disposable">Disposable · clean each Run</MenuItem>
          {(profiles.data ?? []).map(profile => (
            <MenuItem key={profile.id} value={profile.id}>Trusted · {profile.name}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1.5 }}>
        <TextField
          size="small"
          fullWidth
          label="New trusted profile"
          value={newProfileName}
          onChange={event => setNewProfileName(event.target.value)}
          inputProps={{ maxLength: 80 }}
        />
        <Button
          variant="outlined"
          disabled={!newProfileName.trim() || createProfile.isPending}
          onClick={() => createProfile.mutate(newProfileName)}
        >
          Create and use
        </Button>
      </Stack>
      {(profiles.data ?? []).length ? (
        <Stack spacing={0.5} sx={{ mt: 1.5 }}>
          {(profiles.data ?? []).map(profile => (
            <Stack key={profile.id} direction="row" alignItems="center" spacing={1}>
              <Typography variant="body2" sx={{ flex: 1 }}>{profile.name}</Typography>
              <IconButton
                size="small"
                aria-label={`Delete ${profile.name}`}
                disabled={deleteProfile.isPending}
                onClick={() => {
                  deleteProfile.reset();
                  setProfileToDelete(profile);
                }}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      ) : null}
      {error ? <Alert severity="error" sx={{ mt: 1.5 }}>{String(error)}</Alert> : null}
      <Dialog
        open={Boolean(profileToDelete)}
        onClose={() => !deleteProfile.isPending && setProfileToDelete(undefined)}
        aria-labelledby="delete-browser-profile-title"
      >
        <DialogTitle id="delete-browser-profile-title">
          Delete trusted profile “{profileToDelete?.name}”?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes its cookies, logins, and site storage. Every Agent assigned to this profile will return to a disposable browser profile.
          </DialogContentText>
          {deleteProfile.error ? <Alert severity="error" sx={{ mt: 2 }}>{String(deleteProfile.error)}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={deleteProfile.isPending} onClick={() => setProfileToDelete(undefined)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={!profileToDelete || deleteProfile.isPending}
            onClick={() => profileToDelete && deleteProfile.mutate(profileToDelete.id)}
          >
            Delete “{profileToDelete?.name}”
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

interface RuntimeModelChoice {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  group?: string;
}

interface RuntimeEffortChoice {
  id: string;
  label: string;
}

export function AgentSettingsPane({
  agent,
  master,
  organizationalParent,
  managementPermissionsPending,
  managementPermissionsError,
  mcpSummary,
  configuredMcpCount,
  usableMcpCount,
  mcpToolCountLabel,
  steering,
  onStartFreshSession,
  onOpenMaster,
  onManageMemberships,
  onOpenAgent,
  onUpdateManagementPermissions,
  onChangeReportingLine,
}: {
  agent: AgentDto;
  engines: EngineDto[];
  modelCatalogLoading?: boolean;
  settingsEngine: string;
  settingsModel: string;
  settingsEffort: string;
  settingsEngineRegistration?: EngineDto;
  settingsModels: RuntimeModelChoice[];
  settingsEfforts: RuntimeEffortChoice[];
  runtimeSettingsDirty: boolean;
  runtimeSettingsNotice?: string;
  runtimeSettingsPending: boolean;
  runtimeSettingsError?: unknown;
  recheckPending: boolean;
  master?: ConversationDto;
  organizationalParent?: AgentDto;
  managementPermissionsPending: boolean;
  managementPermissionsError?: unknown;
  mcpSummary: string;
  configuredMcpCount: number;
  usableMcpCount: number;
  mcpToolCountLabel: string;
  steering?: boolean;
  onSettingsEngineChange(value: string): void;
  onSettingsModelChange(value: string): void;
  onSettingsEffortChange(value: string): void;
  onSaveRuntimeSettings(): void;
  onRecheckEngine(): void;
  onStartFreshSession(): void;
  onOpenMaster(conversationId: string): void;
  onManageMemberships(): void;
  onOpenAgent(agentId: string): void;
  onUpdateManagementPermissions(value: AgentManagementPermissionsDto): void;
  onChangeReportingLine(): void;
}): JSX.Element {
  return (
    <Stack
      spacing={2}
      aria-label="Agent settings"
      className="ponderosa-scroll"
      sx={{ p: { xs: 1.5, sm: 2.5 }, pb: 4, overflowY: "auto", minHeight: 0 }}
    >
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        sx={{ alignItems: { sm: "center" } }}
      >
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6">Agent Settings</Typography>
          <Typography variant="body2" color="text.secondary">
            Agent assignments, organization, permissions, and runtime
            capabilities.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<RestartAltIcon />}
          onClick={onStartFreshSession}
          sx={{ alignSelf: { xs: "stretch", sm: "center" } }}
        >
          Start Fresh Provider Session For Next Run
        </Button>
      </Stack>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          Chat Assignments
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {master ? (
            <>
              Home Chat:{" "}
              <Link component="button" onClick={() => onOpenMaster(master.id)}>
                {master.title}
              </Link>
            </>
          ) : (
            "This Agent is not assigned to a Project Chat."
          )}
        </Typography>
        <Button
          variant="outlined"
          startIcon={<ForumOutlinedIcon />}
          onClick={onManageMemberships}
        >
          Manage Chat Assignments
        </Button>
      </Paper>
      <AgentWorkingCopySettings agent={agent} />
      <AgentBrowserProfileSettings agent={agent} />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          Organization And Automatic Child Management
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {organizationalParent ? (
            <>
              Delegated Under{" "}
              <Link
                component="button"
                onClick={() => onOpenAgent(organizationalParent.id)}
              >
                {organizationalParent.title}
              </Link>
            </>
          ) : (
            "Top-Level Agent"
          )}
        </Typography>
        <Stack spacing={1}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={
                  agent.managementPermissions.allowAutomaticDescendantDeletion
                }
                disabled={managementPermissionsPending}
                onChange={(_event, checked) =>
                  onUpdateManagementPermissions({
                    ...agent.managementPermissions,
                    allowAutomaticDescendantDeletion: checked,
                  })
                }
              />
            }
            label="Allow Automatic Descendant Deletion"
          />
          <Typography variant="caption" color="text.secondary" sx={{ pl: 6 }}>
            May cancel active work and permanently delete descendant branches
            without another Decision.
          </Typography>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={
                  agent.managementPermissions
                    .allowAutomaticDescendantReorganization
                }
                disabled={managementPermissionsPending}
                onChange={(_event, checked) =>
                  onUpdateManagementPermissions({
                    ...agent.managementPermissions,
                    allowAutomaticDescendantReorganization: checked,
                  })
                }
              />
            }
            label="Allow Automatic Descendant Reorganization"
          />
          <Typography variant="caption" color="text.secondary" sx={{ pl: 6 }}>
            May rearrange reporting lines inside its subtree, but cannot detach
            or promote descendants.
          </Typography>
          <Button
            variant="outlined"
            startIcon={<AccountTreeOutlinedIcon />}
            onClick={onChangeReportingLine}
          >
            Change Reporting Line
          </Button>
          {managementPermissionsError ? (
            <Alert severity="error">
              {String(managementPermissionsError)}
            </Alert>
          ) : null}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          Runtime Capabilities
        </Typography>
        <Tooltip
          title={<span style={{ whiteSpace: "pre-line" }}>{mcpSummary}</span>}
        >
          <Chip
            size="small"
            variant="outlined"
            color={usableMcpCount > 0 ? "success" : "default"}
            label={`${usableMcpCount}/${configuredMcpCount} MCPs · ${mcpToolCountLabel}${steering ? " · Steerable" : ""}`}
            sx={{ mt: 1 }}
          />
        </Tooltip>
      </Paper>
    </Stack>
  );
}
