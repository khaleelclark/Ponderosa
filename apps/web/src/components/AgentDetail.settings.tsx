import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  Link,
  ListItemText,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type {
  AgentDto,
  AgentManagementPermissionsDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import {
  effortSelectionIsCompatible,
  engineIsAvailable,
} from "../conversationEngine";

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
  engines,
  modelCatalogLoading,
  settingsEngine,
  settingsModel,
  settingsEffort,
  settingsEngineRegistration,
  settingsModels,
  settingsEfforts,
  runtimeSettingsDirty,
  runtimeSettingsNotice,
  runtimeSettingsPending,
  runtimeSettingsError,
  recheckPending,
  master,
  organizationalParent,
  managementPermissionsPending,
  managementPermissionsError,
  mcpSummary,
  configuredMcpCount,
  usableMcpCount,
  mcpToolCountLabel,
  steering,
  onSettingsEngineChange,
  onSettingsModelChange,
  onSettingsEffortChange,
  onSaveRuntimeSettings,
  onRecheckEngine,
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
      <Box>
        <Typography variant="h6">Agent Settings</Typography>
        <Typography variant="body2" color="text.secondary">
          Agent controls, assignments, permissions, and runtime choices for
          upcoming work.
        </Typography>
      </Box>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          Provider and next Run
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Provider, model, and reasoning are persistent Agent defaults. Changes
          apply when the next Run starts; steering an active Run keeps that
          Run&apos;s captured runtime.
        </Typography>
        <Stack spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-detail-engine-label">
              Provider · next Run
            </InputLabel>
            <Select
              labelId="agent-detail-engine-label"
              value={settingsEngine}
              label="Provider · next Run"
              onChange={(event: SelectChangeEvent) =>
                onSettingsEngineChange(event.target.value)
              }
            >
              {engines.map(option => (
                <MenuItem key={option.id} value={option.id}>
                  {option.displayName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Chip
            size="small"
            label={`${settingsEngineRegistration?.displayName ?? settingsEngine}${engineIsAvailable(settingsEngineRegistration) ? "" : settingsEngineRegistration?.authenticated ? " · access unavailable" : " · not signed in"}`}
            color={
              engineIsAvailable(settingsEngineRegistration)
                ? "default"
                : "warning"
            }
            sx={{ alignSelf: "flex-start" }}
          />
          {settingsEngineRegistration?.authenticated &&
          !engineIsAvailable(settingsEngineRegistration) ? (
            <>
              <Typography variant="caption" color="warning.main">
                {settingsEngineRegistration.availabilityDetail ??
                  "The provider rejected runtime access."}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                disabled={recheckPending}
                onClick={onRecheckEngine}
              >
                {recheckPending ? "Testing Access…" : "Test Access"}
              </Button>
            </>
          ) : null}
          {modelCatalogLoading && settingsEngine === "claude" ? (
            <Typography variant="caption" color="text.secondary">
              Refreshing Claude models…
            </Typography>
          ) : null}
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-detail-model-label">
              Model · next Run
            </InputLabel>
            <Select
              labelId="agent-detail-model-label"
              value={
                settingsModels.some(option => option.id === settingsModel)
                  ? settingsModel
                  : ""
              }
              label="Model · next Run"
              onChange={(event: SelectChangeEvent) =>
                onSettingsModelChange(event.target.value)
              }
            >
              <MenuItem value="">Engine Default</MenuItem>
              {settingsModels.flatMap((option, index) => [
                ...(option.group &&
                option.group !== settingsModels[index - 1]?.group
                  ? [
                      <ListSubheader key={`group-${option.group}`}>
                        {option.group}
                      </ListSubheader>,
                    ]
                  : []),
                <MenuItem
                  key={option.id}
                  value={option.id}
                  disabled={option.disabled}
                >
                  <ListItemText
                    primary={option.label}
                    secondary={option.detail}
                  />
                </MenuItem>,
              ])}
            </Select>
          </FormControl>
          {settingsEngine === "claude" ? (
            <Typography variant="caption" color="text.secondary">
              Latest aliases follow future provider upgrades. Pinned exact IDs
              stay on the selected version.
            </Typography>
          ) : null}
          <FormControl size="small" fullWidth>
            <InputLabel id="agent-detail-effort-label">
              Reasoning · next Run
            </InputLabel>
            <Select
              labelId="agent-detail-effort-label"
              value={
                settingsEfforts.some(option => option.id === settingsEffort)
                  ? settingsEffort
                  : ""
              }
              label="Reasoning · next Run"
              onChange={(event: SelectChangeEvent) =>
                onSettingsEffortChange(event.target.value)
              }
            >
              <MenuItem value="">Engine Default</MenuItem>
              {settingsEfforts.map(option => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            size="small"
            variant="contained"
            disabled={
              !runtimeSettingsDirty ||
              runtimeSettingsPending ||
              !settingsEngine
            }
            onClick={onSaveRuntimeSettings}
          >
            {runtimeSettingsPending ? "Saving…" : "Save Runtime Settings"}
          </Button>
          {runtimeSettingsNotice ? (
            <Alert severity="success">{runtimeSettingsNotice}</Alert>
          ) : null}
          {runtimeSettingsError ? (
            <Alert severity="error">{String(runtimeSettingsError)}</Alert>
          ) : null}
          <Button
            size="small"
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={onStartFreshSession}
          >
            Start Fresh Provider Session for Next Run
          </Button>
          <Typography variant="caption" color="text.secondary">
            {agent.state.branch ?? "No branch"}
            {agent.state.commit ? ` · ${agent.state.commit}` : ""}
          </Typography>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          Chat assignments
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {master ? (
            <>
              Home chat:{" "}
              <Link component="button" onClick={() => onOpenMaster(master.id)}>
                {master.title}
              </Link>
            </>
          ) : (
            "This Agent is not assigned to a Project chat."
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
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800}>
          Organization and automatic child management
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {organizationalParent ? (
            <>
              Delegated under{" "}
              <Link
                component="button"
                onClick={() => onOpenAgent(organizationalParent.id)}
              >
                {organizationalParent.title}
              </Link>
            </>
          ) : (
            "Top-level Agent"
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
            label="Allow automatic descendant deletion"
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
            label="Allow automatic descendant reorganization"
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
          Runtime capabilities
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
