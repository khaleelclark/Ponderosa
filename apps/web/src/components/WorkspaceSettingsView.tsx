import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import { BrowserVoiceSettings } from "./speech/BrowserVoiceSettings";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormHelperText,
  InputLabel,
  ListItemText,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { EngineDto, ProjectDto, ProjectEngineModelCatalogDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  effortOptionsForModel,
  engineIsAvailable,
  enginesWithModelCatalog,
  resolveRuntimeSelection,
  runtimeControlState,
} from "../conversationEngine";
import type { ColorMode } from "../theme";
import { ProviderActivitySettingsSection } from "./WorkspaceResourceViews";
import { ProviderStatusDetails } from "./ProviderStatusDialog";
import { ConfirmDialog } from "./ConfirmationDialogs";
import {
  inspectWebPush,
  syncWebPush,
  disableWebPush,
  subscribeWebPushRecovery,
  webPushEnableBlockReason,
  type WebPushState,
} from "../pushNotifications";
import { queryKeys } from "../queryKeys";
import { recheckProvider } from "../providerAuthRefresh";
import {
  OperatorProfileEditor,
  useOperatorProfileForm,
} from "./OperatorProfileEditor";
import { IconTitle } from "./IconTitle";
import { MobileNavigationButton } from "./MobileNavigationContext";
import {
  parseAgentRunConcurrencyLimit,
  RuntimeSettings,
} from "./RuntimeSettings";
import { PrimaryHeaderActionsOutlet } from "./PrimaryHeaderActions";
import {
  draftChangedSinceSubmission,
  synchronizePristineDraft,
} from "./settingsDrafts";
import { useReloadBlocker } from "../reloadSafety";

const GLOBAL_AGENT_INSTRUCTIONS_LABEL = "Global Agent Instructions";
const GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT =
  "Applies to every Agent on the next fresh provider session. Project and Agent instructions follow it. Behavioral preferences, such as preferred models, are guidance rather than guaranteed structural routing.";

function SettingsHeader({
  profile = false,
}: {
  profile?: boolean;
}): JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={1.25}
      sx={{
        alignItems: "center",
        px: { xs: 2, md: 4 },
        py: 2.5,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <MobileNavigationButton />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <IconTitle
          icon={profile ? <PersonOutlineIcon /> : <SettingsOutlinedIcon />}
          title={profile ? "Operator Profile" : "Settings"}
          component="h1"
        />
        <Typography variant="body2" color="text.secondary">
          {profile
            ? "How you appear to Agents and throughout Ponderosa"
            : "Workspace appearance, notifications, providers, and Agent defaults"}
        </Typography>
      </Box>
      <PrimaryHeaderActionsOutlet />
    </Stack>
  );
}

function GeneralSettingsSection({
  preferences,
  colorMode,
  instructions,
  limit,
  rolloverTokens,
  rolloverFraction,
  onToggleColorMode,
  onPreferences,
  onInstructions,
  onLimit,
  onSaveAgentDefaults,
  agentDefaultsSaving,
  agentDefaultsSaved,
  agentDefaultsSaveError,
  onRolloverTokens,
  onRolloverFraction,
  onSaveRollover,
  rolloverSaving,
  rolloverSaved,
  rolloverSaveError,
}: {
  preferences: WorkspacePreferencesDto;
  colorMode: ColorMode;
  instructions: string;
  limit: string;
  rolloverTokens: string;
  rolloverFraction: string;
  onToggleColorMode(): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onInstructions(value: string): void;
  onLimit(value: string): void;
  onSaveAgentDefaults(): void;
  agentDefaultsSaving: boolean;
  agentDefaultsSaved: boolean;
  agentDefaultsSaveError?: string;
  onRolloverTokens(value: string): void;
  onRolloverFraction(value: string): void;
  onSaveRollover(tokens: number, fraction: number): void;
  rolloverSaving: boolean;
  rolloverSaved: boolean;
  rolloverSaveError?: string;
}): JSX.Element {
  const parsedRolloverTokens = Number(rolloverTokens);
  const parsedRolloverFraction = Number(rolloverFraction);
  const rolloverTokensError = !rolloverTokens.trim()
    ? "Enter a rollover threshold."
    : !Number.isFinite(parsedRolloverTokens)
      ? "Enter a valid rollover threshold."
      : parsedRolloverTokens < 75_000 ||
          parsedRolloverTokens > 2_000_000
        ? "Enter between 75,000 and 2,000,000 context tokens."
        : undefined;
  const rolloverFractionError = !rolloverFraction.trim()
    ? "Enter a context-window share."
    : !Number.isFinite(parsedRolloverFraction)
      ? "Enter a valid context-window share."
      : parsedRolloverFraction < 0.3 || parsedRolloverFraction > 0.95
        ? "Enter a value from 0.3 to 0.95."
        : undefined;
  const rolloverValuesValid =
    rolloverTokensError === undefined && rolloverFractionError === undefined;
  return (
    <Stack spacing={2.5}>
      <BrowserVoiceSettings preferences={preferences} onPreferences={onPreferences} />
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="h6" fontWeight={800} sx={{ mb: 1.5 }}>
          Appearance
        </Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <Button variant="outlined" onClick={onToggleColorMode}>
            Use {colorMode === "dark" ? "Light" : "Dark"} Mode
          </Button>
          <FormControl fullWidth>
            <InputLabel id="workspace-font">Font</InputLabel>
            <Select
              labelId="workspace-font"
              label="Font"
              value={preferences.fontFamily}
              onChange={event =>
                onPreferences({
                  fontFamily: event.target
                    .value as WorkspacePreferencesDto["fontFamily"],
                })
              }
            >
              <MenuItem value="inter">Inter</MenuItem>
              <MenuItem value="system">System</MenuItem>
              <MenuItem value="sans">Classic Sans</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="h6" fontWeight={800}>
          Agent Defaults
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          These apply across Ponderosa unless a Project, Chat, or Agent
          overrides them.
        </Typography>
        <Stack spacing={2}>
          <RuntimeSettings value={limit} onChange={onLimit} />
          <TextField
            label={GLOBAL_AGENT_INSTRUCTIONS_LABEL}
            value={instructions}
            onChange={event => onInstructions(event.target.value)}
            multiline
            minRows={6}
            helperText={GLOBAL_AGENT_INSTRUCTIONS_HELPER_TEXT}
          />
          <Button
            variant="contained"
            sx={{ alignSelf: "flex-start" }}
            disabled={
              agentDefaultsSaving ||
              parseAgentRunConcurrencyLimit(limit) === undefined
            }
            onClick={onSaveAgentDefaults}
          >
            {agentDefaultsSaving ? "Saving…" : "Save Agent Defaults"}
          </Button>
          {agentDefaultsSaved ? (
            <Alert severity="success" role="status">
              Agent defaults saved successfully.
            </Alert>
          ) : null}
          {agentDefaultsSaveError ? (
            <Alert severity="error" role="alert">
              {agentDefaultsSaveError}
            </Alert>
          ) : null}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="h6" fontWeight={800}>
          Provider Session Rollover
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          When a session passes either limit, Ponderosa asks the Agent to write
          a short handoff, then starts a fresh provider session at the next safe
          boundary. The provider&apos;s own compaction remains the fallback.
        </Typography>
        <Stack spacing={2}>
          <FormControlLabel
            control={
              <Switch
                checked={preferences.contextRolloverEnabled}
                onChange={(_, checked) =>
                  onPreferences({ contextRolloverEnabled: checked })
                }
              />
            }
            label="Proactive context rollover"
          />
          <TextField
            type="number"
            label="Roll over above (context tokens)"
            value={rolloverTokens}
            onChange={event => onRolloverTokens(event.target.value)}
            inputProps={{ min: 75_000, max: 2_000_000, step: 10_000 }}
            error={Boolean(rolloverTokensError)}
            helperText={
              rolloverTokensError ??
              "Minimum 75,000. Fresh Ponderosa sessions already consume substantial context, so lower values can cause repeated rollover. Default 150,000."
            }
          />
          <TextField
            type="number"
            label="Or at this share of the provider's context window"
            value={rolloverFraction}
            onChange={event => onRolloverFraction(event.target.value)}
            inputProps={{ min: 0.3, max: 0.95, step: 0.05 }}
            error={Boolean(rolloverFractionError)}
            helperText={
              rolloverFractionError ??
              "Applies only to providers that report a window size (Codex does; Claude does not). Catches sessions configured with a small window, where the token ceiling above would never be reached."
            }
          />
          <Button
            variant="contained"
            sx={{ alignSelf: "flex-start" }}
            disabled={!rolloverValuesValid || rolloverSaving}
            onClick={() => onSaveRollover(
              parsedRolloverTokens,
              parsedRolloverFraction,
            )}
          >
            {rolloverSaving ? "Saving…" : "Save Rollover Limits"}
          </Button>
          {rolloverSaveError ? <Alert severity="error">{rolloverSaveError}</Alert> : rolloverSaved ? <Alert severity="success" role="status">Rollover limits saved</Alert> : null}
        </Stack>
      </Paper>
    </Stack>
  );
}

const NOTIFICATION_LABELS: Array<
  [keyof WorkspacePreferencesDto["notifications"], string]
> = [
  ["directResponses", "Direct Agent responses"],
  ["broadcasts", "Project broadcasts"],
];

function NotificationSettingsSection({
  preferences,
  pushState,
  pushBusy,
  onPreferences,
  onEnablePush,
  onDisablePush,
}: {
  preferences: WorkspacePreferencesDto;
  pushState: WebPushState;
  pushBusy: boolean;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onEnablePush(): void;
  onDisablePush(): void;
}): JSX.Element {
  const enableBlockReason = webPushEnableBlockReason(pushState);
  const pushSeverity = pushState.kind === "active"
    ? "success" as const
    : pushState.kind === "permission_denied" || pushState.kind === "subscription_failed"
      ? "error" as const
      : "info" as const;
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" fontWeight={800}>
        Notifications
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose which Agent updates appear in Notifications and browser push. Chat and Agent notification settings can further limit these alerts, including those that need attention.
      </Typography>
      <Stack>
        {NOTIFICATION_LABELS.map(([key, label]) => (
            <FormControlLabel
              key={key}
              control={
                <Checkbox
                  checked={preferences.notifications[key]}
                  onChange={event =>
                    onPreferences({
                      notifications: {
                        ...preferences.notifications,
                        [key]: event.target.checked,
                      },
                    })
                  }
                />
              }
              label={label}
            />
        ))}
      </Stack>
      <Alert
        severity={pushSeverity}
        sx={{ mt: 2 }}
        aria-live="polite"
      >
        {pushState.message} In-app notifications remain available.
      </Alert>
      <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
        {pushState.kind === "active" ? (
          <Button
            disabled={pushBusy}
            onClick={onDisablePush}
            variant="contained"
          >
            Disable on This Device
          </Button>
        ) : (
          <Tooltip title={enableBlockReason ?? ""}>
            <span>
              <Button
                variant="outlined"
                disabled={pushBusy || Boolean(enableBlockReason)}
                onClick={onEnablePush}
              >
                Enable Browser Push
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>
    </Paper>
  );
}

function ClaudeModelOptionsSettings({
  engine,
  preferences,
  projectId,
  catalogLoading,
  onPreferences,
}: {
  engine: EngineDto;
  preferences: WorkspacePreferencesDto;
  projectId?: string;
  catalogLoading: boolean;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const [modelId, setModelId] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const [validationRequestError, setValidationRequestError] = useState<string>();
  const queryClient = useQueryClient();
  const normalizedId = modelId.trim();
  const configured = engine.configuredModels ?? [];
  const idAlreadyExists = Boolean(normalizedId) &&
    engine.models.some(model => model.id === normalizedId);
  const validateModel = useMutation({
    mutationFn: () => api.validateEngineModel(projectId!, "claude", normalizedId),
  });
  const addModel = async () => {
    if (!projectId || !normalizedId || idAlreadyExists) return;
    setValidationError(undefined);
    setValidationRequestError(undefined);
    let result;
    try {
      result = await validateModel.mutateAsync();
    } catch (error) {
      setValidationRequestError(
        error instanceof Error
          ? error.message
          : "The model could not be validated.",
      );
      return;
    }
    if (!result.valid) {
      setValidationError(result.error);
      return;
    }
    onPreferences({
      claudeModelOptions: [
        ...preferences.claudeModelOptions,
        {
          id: result.model.id,
          label: result.model.label,
          ...(result.model.resolvedModel ? { resolvedModel: result.model.resolvedModel } : {}),
          ...(result.model.validatedAt ? { validatedAt: result.model.validatedAt } : {}),
          availability: result.model.availability ?? "available",
        },
      ],
    });
    queryClient.setQueryData<ProjectEngineModelCatalogDto>(
      queryKeys.engines.models(projectId, "claude"),
      current => current && !current.models.some((model) => model.id === result.model.id)
        ? { ...current, models: [...current.models, result.model] }
        : current,
    );
    setModelId("");
  };
  return (
    <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
      <Typography fontWeight={700}>Pinned Claude Model Versions</Typography>
      {catalogLoading ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Refreshing Claude models…
        </Typography>
      ) : null}
      {configured.length ? (
        <Stack spacing={0.75} sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Environment-configured models
          </Typography>
          {configured.map(model => (
            <Box key={model.id}>
              <Typography variant="body2">{model.label}</Typography>
              <Typography variant="caption" color="text.secondary">
                {model.id}
              </Typography>
            </Box>
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          No specific versions are pinned by the environment. Set
          {" "}ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL,
          ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_FABLE_MODEL, or
          ANTHROPIC_CUSTOM_MODEL_OPTION to add host-managed choices.
        </Typography>
      )}
      <Stack spacing={1} sx={{ mt: 2 }}>
        <Typography variant="caption" color="text.secondary">
          Workspace-managed models
        </Typography>
        {preferences.claudeModelOptions.map(model => (
          <Stack
            key={model.id}
            direction="row"
            spacing={1}
            sx={{ alignItems: "center" }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2">{model.label || model.id}</Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: "anywhere" }}
              >
                {model.id}
              </Typography>
              {model.validatedAt ? (
                <Typography variant="caption" display="block" color={model.availability === "unavailable" ? "warning.main" : "success.main"}>
                  {model.availability === "unavailable"
                    ? `Unavailable · ${model.unavailableReason ?? "Claude rejected this model"}`
                    : `Validated ${new Date(model.validatedAt).toLocaleString()}`}
                </Typography>
              ) : null}
            </Box>
            <Button
              size="small"
              color="inherit"
              onClick={() =>
                onPreferences({
                  claudeModelOptions: preferences.claudeModelOptions.filter(
                    candidate => candidate.id !== model.id,
                  ),
                })
              }
            >
              Remove
            </Button>
          </Stack>
        ))}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField
            fullWidth
            label="Model id"
            value={modelId}
            onChange={event => {
              setModelId(event.target.value);
              setValidationError(undefined);
              setValidationRequestError(undefined);
            }}
            helperText={
              idAlreadyExists
                ? "This model id is already available."
                : "Use the exact versioned id accepted by Claude Code."
            }
            error={Boolean(normalizedId && idAlreadyExists)}
          />
          <Button
            variant="outlined"
            disabled={!projectId || !normalizedId || idAlreadyExists || validateModel.isPending}
            onClick={() => void addModel()}
            sx={{ alignSelf: { xs: "stretch", sm: "flex-start" }, minHeight: 56 }}
          >
            {validateModel.isPending ? "Validating…" : "Validate & Add"}
          </Button>
        </Stack>
        {validationError ? <Alert severity="error">{validationError}</Alert> : null}
        {validationRequestError ? (
          <Alert
            severity="error"
            action={<Button color="inherit" size="small" onClick={() => void addModel()}>Retry</Button>}
          >
            Model validation failed. {validationRequestError}
          </Alert>
        ) : null}
        {!projectId ? (
          <Alert severity="info">Create a Project before validating a Claude model.</Alert>
        ) : null}
      </Stack>
    </Box>
  );
}

function ProviderSettingsSection({
  preferences,
  engines,
  updatePending,
  updateError,
  validationProjectId,
  modelCatalogLoading,
  recheckEngineId,
  recheckPendingEngineId,
  recheckError,
  onPreferences,
  onToggleEngine,
  onRetryToggleEngine,
  onRecheckEngine,
}: {
  preferences: WorkspacePreferencesDto;
  engines: EngineDto[];
  updatePending: boolean;
  updateError?: string;
  validationProjectId?: string;
  modelCatalogLoading: boolean;
  recheckEngineId?: string;
  recheckPendingEngineId?: string;
  recheckError?: string;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onToggleEngine(engineId: string, enabled: boolean): void;
  onRetryToggleEngine(): void;
  onRecheckEngine(engineId: string): void;
}): JSX.Element {
  const usageProviders = engines.filter(engine =>
    engine.authentication === "authenticated" &&
    Boolean(engine.providerUsageCommand)
  );
  const defaultUsageProvider = usageProviders.some(
    engine =>
      engine.id === preferences.defaultUsageProvider && engine.enabled !== false,
  )
    ? preferences.defaultUsageProvider
    : usageProviders.find(engine => engine.enabled !== false)?.id;
  return (
    <Stack spacing={2}>
      {updateError ? (
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" onClick={onRetryToggleEngine}>Retry</Button>}
        >
          Provider setting was not saved. {updateError}
        </Alert>
      ) : null}
      {engines.length === 0 ? (
        <Alert severity="info">
          No AI providers are registered yet. Install and authenticate Codex or
          Claude Code on this host, then refresh Ponderosa.
        </Alert>
      ) : null}
      {usageProviders.length > 1 ? (
        <Paper variant="outlined" sx={{ p: 2.5 }}>
          <Typography variant="h6" fontWeight={800}>
            Provider Usage
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Choose which provider appears in the usage button by default.
            Agent pages can temporarily show that Agent&apos;s active provider.
          </Typography>
          <FormControl fullWidth>
            <InputLabel id="settings-default-usage-provider">
              Default Provider
            </InputLabel>
            <Select
              labelId="settings-default-usage-provider"
              label="Default Provider"
              value={defaultUsageProvider}
              onChange={event =>
                onPreferences({ defaultUsageProvider: event.target.value })
              }
            >
              {usageProviders.map(engine => (
                <MenuItem
                  key={engine.id}
                  value={engine.id}
                  disabled={engine.enabled === false}
                >
                  {engine.displayName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Paper>
      ) : null}
      {engines.map(engine => {
        const resolved = resolveRuntimeSelection(engine, preferences);
        const modelState = runtimeControlState(engine, resolved);
        const selectedModel = modelState.models.find(
          option => option.id === resolved.model,
        );
        const efforts = effortOptionsForModel(engine, resolved.model);
        return (
          <Paper key={engine.id} variant="outlined" sx={{ p: 2.5 }}>
            <FormControlLabel
              sx={{
                maxWidth: "100%",
                "& .MuiFormControlLabel-label": {
                  minWidth: 0,
                  maxWidth: "100%",
                },
              }}
              control={
                <Switch
                  checked={engine.enabled !== false}
                  disabled={updatePending}
                  onChange={(_, enabled) => onToggleEngine(engine.id, enabled)}
                />
              }
              label={
                <Box sx={{ minWidth: 0, maxWidth: "100%" }}>
                  <Typography fontWeight={800}>{engine.displayName}</Typography>
                  <Typography
                    variant="caption"
                    color={engine.intakeReady ? "text.secondary" : "warning.main"}
                    sx={{
                      display: "block",
                      maxWidth: "100%",
                      overflowWrap: "anywhere",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {engine.reachability === "reachable"
                      ? "Reachable"
                      : engine.intakeReady
                        ? "Intake ready"
                      : (engine.availabilityDetail ?? "Unavailable")}
                  </Typography>
                </Box>
              }
            />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Disabled providers finish active Runs, then hold queued work until
              re-enabled.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <FormControl fullWidth>
                <InputLabel id={`settings-model-${engine.id}`}>
                  Saved Model for New Agents
                </InputLabel>
                <Select
                  labelId={`settings-model-${engine.id}`}
                  label="Saved Model for New Agents"
                  value={resolved.model}
                  renderValue={() => selectedModel?.label ?? resolved.model}
                  onChange={event => {
                    const model = event.target.value;
                    const effort =
                      engine.models.find(option => option.id === model)
                        ?.defaultEffort ?? engine.defaultEffort;
                    onPreferences({
                      engineDefaults: {
                        ...preferences.engineDefaults,
                        [engine.id]: { model, ...(effort ? { effort } : {}) },
                      },
                    });
                  }}
                >
                  {modelState.models.flatMap((option, index) => [
                    ...(option.group && option.group !== modelState.models[index - 1]?.group
                      ? [<ListSubheader key={`group-${option.group}`}>{option.group}</ListSubheader>]
                      : []),
                    <MenuItem key={option.id || "provider-default"} value={option.id} disabled={option.disabled}>
                      <ListItemText primary={option.label} secondary={option.detail} />
                    </MenuItem>,
                  ])}
                </Select>
                {selectedModel?.detail ? (
                  <FormHelperText>{selectedModel.detail}</FormHelperText>
                ) : null}
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id={`settings-effort-${engine.id}`}>
                  Saved Reasoning for New Agents
                </InputLabel>
                <Select
                  labelId={`settings-effort-${engine.id}`}
                  label="Saved Reasoning for New Agents"
                  value={resolved.effort}
                  onChange={event =>
                    onPreferences({
                      engineDefaults: {
                        ...preferences.engineDefaults,
                        [engine.id]: {
                          model: resolved.model,
                          effort: event.target.value,
                        },
                      },
                    })
                  }
                >
                  {efforts.map(option => (
                    <MenuItem key={option.id} value={option.id}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            {engine.configuredModels !== undefined ? (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                  Latest aliases follow future Claude upgrades. Pinned exact IDs stay on the selected version.
                </Typography>
                <ClaudeModelOptionsSettings
                  engine={engine}
                  preferences={preferences}
                  projectId={validationProjectId}
                  catalogLoading={modelCatalogLoading}
                  onPreferences={onPreferences}
                />
              </>
            ) : null}
            {engine.enabled !== false && !engineIsAvailable(engine) ? (
              <Alert
                severity="warning"
                sx={{ mt: 2 }}
                action={
                  <Button
                    color="inherit"
                    size="small"
                    disabled={recheckPendingEngineId === engine.id}
                    onClick={() => onRecheckEngine(engine.id)}
                  >
                    {recheckPendingEngineId === engine.id
                      ? "Checking…"
                      : "Recheck sign-in"}
                  </Button>
                }
              >
                {engine.authentication === "authenticated"
                  ? "Provider access needs attention before it can start new work."
                  : "Sign in on this host, then return to Ponderosa. Sign-in will be checked automatically."}
              </Alert>
            ) : null}
            {recheckError && recheckEngineId === engine.id ? (
              <Alert severity="error" sx={{ mt: 2 }}>
                {recheckError}
              </Alert>
            ) : null}
          </Paper>
        );
      })}
    </Stack>
  );
}

export function WorkspaceSettingsView({
  preferences,
  engines,
  projects,
  colorMode,
  onToggleColorMode,
  onPreferences,
  onSavePreferences,
  section = "general",
  activityProjectId,
}: {
  preferences: WorkspacePreferencesDto;
  engines: EngineDto[];
  projects: ProjectDto[];
  colorMode: ColorMode;
  onToggleColorMode(): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onSavePreferences(
    patch: Partial<WorkspacePreferencesDto>,
  ): Promise<WorkspacePreferencesDto>;
  section?: "profile" | "general" | "providers" | "notifications" | "activity";
  activityProjectId?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const validationProject = projects[0];
  const modelCatalogQuery = useQuery({
    queryKey: queryKeys.engines.models(validationProject?.id, "claude"),
    queryFn: () => api.getEngineModels(validationProject!.id, "claude"),
    enabled: Boolean(validationProject && engines.some((engine) => engine.id === "claude")),
    staleTime: 5 * 60_000,
  });
  const readinessQuery = useQuery({
    queryKey: queryKeys.readiness.all,
    queryFn: () => api.getReadiness(),
    enabled: section === "activity",
    staleTime: 30_000,
  });
  const settingsEngines = enginesWithModelCatalog(engines, modelCatalogQuery.data);
  const [instructions, setInstructions] = useState(
    preferences.globalInstructions,
  );
  const [limit, setLimit] = useState(
    String(preferences.maxConcurrentAgentRuns),
  );
  const [rolloverTokens, setRolloverTokens] = useState(
    String(preferences.contextRolloverTokens),
  );
  const [rolloverFraction, setRolloverFraction] = useState(
    String(preferences.contextRolloverWindowFraction),
  );
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [limitDirty, setLimitDirty] = useState(false);
  const [rolloverTokensDirty, setRolloverTokensDirty] = useState(false);
  const [rolloverFractionDirty, setRolloverFractionDirty] = useState(false);
  useReloadBlocker(
    "workspace-settings",
    instructionsDirty || limitDirty || rolloverTokensDirty || rolloverFractionDirty,
  );
  const instructionsRef = useRef(instructions);
  const limitRef = useRef(limit);
  const rolloverTokensRef = useRef(rolloverTokens);
  const rolloverFractionRef = useRef(rolloverFraction);
  instructionsRef.current = instructions;
  limitRef.current = limit;
  rolloverTokensRef.current = rolloverTokens;
  rolloverFractionRef.current = rolloverFraction;
  const [pushState, setPushState] = useState<WebPushState>({
    kind: "permission_default",
    message: "Checking browser push status…",
  });
  const [pushBusy, setPushBusy] = useState(false);
  const [engineToTest, setEngineToTest] = useState<EngineDto>();
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void inspectWebPush().then((state) => {
        if (active) setPushState(state);
      });
    };
    refresh();
    const unsubscribe = subscribeWebPushRecovery(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    setInstructions(current => synchronizePristineDraft(
      current,
      preferences.globalInstructions,
      instructionsDirty,
    ));
  }, [instructionsDirty, preferences.globalInstructions]);
  useEffect(() => {
    setLimit(current => synchronizePristineDraft(
      current,
      String(preferences.maxConcurrentAgentRuns),
      limitDirty,
    ));
  }, [limitDirty, preferences.maxConcurrentAgentRuns]);
  useEffect(() => {
    setRolloverTokens(current => synchronizePristineDraft(
      current,
      String(preferences.contextRolloverTokens),
      rolloverTokensDirty,
    ));
  }, [preferences.contextRolloverTokens, rolloverTokensDirty]);
  useEffect(() => {
    setRolloverFraction(current => synchronizePristineDraft(
      current,
      String(preferences.contextRolloverWindowFraction),
      rolloverFractionDirty,
    ));
  }, [preferences.contextRolloverWindowFraction, rolloverFractionDirty]);
  const updateEngine = useMutation({
    mutationFn: ({
      engineId,
      enabled,
    }: {
      engineId: string;
      enabled: boolean;
    }) => api.updateEngine(engineId, { enabled }),
    onSuccess: updated => {
      queryClient.setQueryData<EngineDto[]>(queryKeys.engines.all, current =>
        current?.map(candidate =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
    },
  });
  const recheckEngine = useMutation({
    mutationFn: (engineId: string) => recheckProvider(queryClient, engineId),
    onSuccess: () => setEngineToTest(undefined),
  });
  const saveAgentDefaults = useMutation({
    mutationFn: (patch: {
      globalInstructions: string;
      maxConcurrentAgentRuns: number;
    }) => onSavePreferences(patch),
    onSuccess: (_preferences, submitted) => {
      setInstructionsDirty(draftChangedSinceSubmission(
        instructionsRef.current,
        submitted.globalInstructions,
      ));
      setLimitDirty(draftChangedSinceSubmission(
        limitRef.current,
        String(submitted.maxConcurrentAgentRuns),
      ));
    },
  });
  const saveRollover = useMutation({
    mutationFn: (patch: { contextRolloverTokens: number; contextRolloverWindowFraction: number }) => onSavePreferences(patch),
    onSuccess: (_saved, submitted) => {
      setRolloverTokensDirty(rolloverTokensRef.current !== String(submitted.contextRolloverTokens));
      setRolloverFractionDirty(rolloverFractionRef.current !== String(submitted.contextRolloverWindowFraction));
    },
  });
  useEffect(() => {
    if (!saveAgentDefaults.isSuccess) return;

    const timeoutId = window.setTimeout(() => {
      saveAgentDefaults.reset();
    }, 3_000);

    return () => window.clearTimeout(timeoutId);
  }, [saveAgentDefaults.isSuccess, saveAgentDefaults.reset]);
  const setPushFrom = (action: () => Promise<WebPushState>) => {
    setPushBusy(true);
    void action()
      .then(setPushState)
      .finally(() => setPushBusy(false));
  };
  return (
    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}>
      <SettingsHeader />
      <Box sx={{ maxWidth: 900, mx: "auto", p: { xs: 2, md: 4 } }}>
        {section === "profile" ? (
          <OperatorProfileSettingsSection
            preferences={preferences}
            onSavePreferences={onSavePreferences}
          />
        ) : null}
        {section === "general" ? (
          <GeneralSettingsSection
            preferences={preferences}
            colorMode={colorMode}
            instructions={instructions}
            limit={limit}
            rolloverTokens={rolloverTokens}
            rolloverFraction={rolloverFraction}
            onToggleColorMode={onToggleColorMode}
            onPreferences={onPreferences}
            onInstructions={value => {
              saveAgentDefaults.reset();
              setInstructionsDirty(true);
              setInstructions(value);
            }}
            onLimit={value => {
              saveAgentDefaults.reset();
              setLimitDirty(true);
              setLimit(value);
            }}
            onSaveAgentDefaults={() =>
              saveAgentDefaults.mutate({
                globalInstructions: instructions,
                maxConcurrentAgentRuns:
                  parseAgentRunConcurrencyLimit(limit)!,
              })
            }
            agentDefaultsSaving={saveAgentDefaults.isPending}
            agentDefaultsSaved={saveAgentDefaults.isSuccess}
            agentDefaultsSaveError={
              saveAgentDefaults.isError
                ? saveAgentDefaults.error instanceof Error
                  ? saveAgentDefaults.error.message
                  : "Agent defaults could not be saved."
                : undefined
            }
            onRolloverTokens={value => {
              setRolloverTokensDirty(true);
              setRolloverTokens(value);
            }}
            onRolloverFraction={value => {
              setRolloverFractionDirty(true);
              setRolloverFraction(value);
            }}
            onSaveRollover={(tokens, fraction) => {
              saveRollover.mutate({
                contextRolloverTokens: tokens,
                contextRolloverWindowFraction: fraction,
              });
            }}
            rolloverSaving={saveRollover.isPending}
            rolloverSaved={saveRollover.isSuccess && !rolloverTokensDirty && !rolloverFractionDirty}
            rolloverSaveError={saveRollover.isError ? saveRollover.error instanceof Error ? saveRollover.error.message : "Rollover limits could not be saved. Try again." : undefined}
          />
        ) : null}
        {section === "notifications" ? (
          <NotificationSettingsSection
            preferences={preferences}
            pushState={pushState}
            pushBusy={pushBusy}
            onPreferences={onPreferences}
            onEnablePush={() => setPushFrom(() => syncWebPush(true))}
            onDisablePush={() => setPushFrom(disableWebPush)}
          />
        ) : null}
        {section === "providers" ? (
          <ProviderSettingsSection
            preferences={preferences}
            engines={settingsEngines}
            updatePending={updateEngine.isPending}
            updateError={
              updateEngine.isError
                ? updateEngine.error instanceof Error
                  ? updateEngine.error.message
                  : "The provider could not be updated."
                : undefined
            }
            validationProjectId={validationProject?.id}
            modelCatalogLoading={modelCatalogQuery.isLoading}
            recheckEngineId={recheckEngine.variables}
            recheckPendingEngineId={
              recheckEngine.isPending ? recheckEngine.variables : undefined
            }
            recheckError={
              recheckEngine.isError
                ? recheckEngine.error instanceof Error
                  ? recheckEngine.error.message
                  : "Provider sign-in could not be checked."
                : undefined
            }
            onPreferences={onPreferences}
            onToggleEngine={(engineId, enabled) =>
              updateEngine.mutate({ engineId, enabled })
            }
            onRetryToggleEngine={() => {
              if (updateEngine.variables) updateEngine.mutate(updateEngine.variables);
            }}
            onRecheckEngine={engineId => recheckEngine.mutate(engineId)}
          />
        ) : null}
        {section === "activity" ? (
          <Stack spacing={2.5}>
            <Paper variant="outlined" sx={{ p: 2.5 }}>
              <Typography variant="h6" fontWeight={800}>Provider Status</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Sign-in, runtime access, and network availability for configured AI providers.
              </Typography>
              <ProviderStatusDetails
                engines={engines}
                networkSecurity={readinessQuery.data?.networkSecurity}
                networkSecurityLoading={readinessQuery.isLoading}
                networkSecurityError={readinessQuery.isError ? String(readinessQuery.error) : undefined}
                recheckingEngineId={recheckEngine.isPending ? recheckEngine.variables : undefined}
                error={recheckEngine.isError ? String(recheckEngine.error) : undefined}
                onTestAccess={engine => {
                  recheckEngine.reset();
                  setEngineToTest(engine);
                }}
              />
            </Paper>
            <ProviderActivitySettingsSection
              projects={projects}
              projectId={activityProjectId}
            />
          </Stack>
        ) : null}
      </Box>
      <ConfirmDialog
        open={Boolean(engineToTest)}
        title={`Test ${engineToTest?.displayName ?? "provider"} access?`}
        confirmLabel="Test Access"
        pendingLabel="Testing…"
        pending={recheckEngine.isPending}
        error={recheckEngine.isError ? String(recheckEngine.error) : undefined}
        onCancel={() => {
          recheckEngine.reset();
          setEngineToTest(undefined);
        }}
        onConfirm={() => {
          if (engineToTest) recheckEngine.mutate(engineToTest.id);
        }}
      >
        <Typography sx={{ pt: 1 }}>This sends one minimal subscription-backed request.</Typography>
      </ConfirmDialog>
    </Box>
  );
}

function OperatorProfileSettingsSection({
  preferences,
  onSavePreferences,
}: {
  preferences: WorkspacePreferencesDto;
  onSavePreferences(patch: Partial<WorkspacePreferencesDto>): Promise<WorkspacePreferencesDto>;
}): JSX.Element {
  const form = useOperatorProfileForm(preferences.profile);
  const save = useMutation({ mutationFn: (profile: WorkspacePreferencesDto["profile"]) => onSavePreferences({ profile }) });
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
      <OperatorProfileEditor
        form={form}
        avatarSize={72}
        nameLabel="What Agents Call You"
        handleHelperText="# identifies people and Agents; @ references files. Historical mentions continue to follow your stable identity."
        pictureLabelId="profile-picture"
        avatarFirst
        showDescription
      />
      <Button
        variant="contained"
        disabled={form.busy || !form.valid || save.isPending}
        onClick={() => save.mutate(form.profile)}
        sx={{ alignSelf: "flex-start", mt: 2.25 }}
      >
        {save.isPending ? "Saving…" : "Save Profile"}
      </Button>
      {save.isError ? <Alert severity="error" sx={{ mt: 1 }}>{save.error instanceof Error ? save.error.message : "Profile could not be saved. Try again."}</Alert> : save.isSuccess && JSON.stringify(save.variables) === JSON.stringify(form.profile) ? <Alert severity="success" role="status" sx={{ mt: 1 }}>Profile saved</Alert> : null}
    </Paper>
  );
}

export function OperatorProfileWorkspace({
  preferences,
  onSavePreferences,
}: {
  preferences: WorkspacePreferencesDto;
  onSavePreferences(patch: Partial<WorkspacePreferencesDto>): Promise<WorkspacePreferencesDto>;
}): JSX.Element {
  return (
    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}>
      <SettingsHeader profile />
      <Box sx={{ maxWidth: 720, mx: "auto", p: { xs: 2, md: 4 } }}>
        <OperatorProfileSettingsSection
          preferences={preferences}
          onSavePreferences={onSavePreferences}
        />
      </Box>
    </Box>
  );
}
