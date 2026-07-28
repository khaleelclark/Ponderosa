import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AgentDto,
  AgentManagementPermissionsDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";

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
