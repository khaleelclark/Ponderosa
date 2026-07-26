import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListItemText,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type { EngineDto, ProjectDto, ProjectEngineModelCatalogDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import {
  effortOptionsForModel,
  engineIsAvailable,
  enginesWithModelCatalog,
  resolveRuntimeSelection,
  runtimeControlState,
} from "../conversationEngine";
import type { ColorMode } from "../theme";
import {
  inspectWebPush,
  syncWebPush,
  disableWebPush,
  type WebPushState,
} from "../pushNotifications";
import { queryKeys } from "../queryKeys";
import {
  OperatorProfileEditor,
  useOperatorProfileForm,
} from "./OperatorProfileEditor";
import { IconTitle } from "./IconTitle";
import {
  parseAgentRunConcurrencyLimit,
  RuntimeSettings,
} from "./RuntimeSettings";

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
      <Box sx={{ minWidth: 0 }}>
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
}): JSX.Element {
  const parsedRolloverTokens = Number(rolloverTokens);
  const parsedRolloverFraction = Number(rolloverFraction);
  const rolloverValuesValid =
    Number.isFinite(parsedRolloverTokens) &&
    Number.isFinite(parsedRolloverFraction);
  return (
    <Stack spacing={2.5}>
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
            inputProps={{ min: 20_000, max: 2_000_000, step: 10_000 }}
            helperText="Counts everything occupying the provider's context window, including cached tokens — not just new input. Default 150,000."
          />
          <TextField
            type="number"
            label="Or at this share of the provider's context window"
            value={rolloverFraction}
            onChange={event => onRolloverFraction(event.target.value)}
            inputProps={{ min: 0.3, max: 0.95, step: 0.05 }}
            helperText="Applies only to providers that report a window size (Codex does; Claude does not). Catches sessions configured with a small window, where the token ceiling above would never be reached."
          />
          <Button
            variant="contained"
            sx={{ alignSelf: "flex-start" }}
            disabled={!rolloverValuesValid}
            onClick={() =>
              onPreferences({
                contextRolloverTokens: parsedRolloverTokens,
                contextRolloverWindowFraction: parsedRolloverFraction,
              })
            }
          >
            Save Rollover Limits
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}

const NOTIFICATION_LABELS: Array<
  [keyof WorkspacePreferencesDto["notifications"], string]
> = [
  ["mentions", "Mentions"],
  ["directReplies", "Direct Replies"],
  ["projectChatMessages", "Project Chat Messages"],
  ["broadcasts", "Broadcasts / #everyone"],
  ["allMessages", "All Messages"],
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
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" fontWeight={800}>
        Notifications
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose which activity should ask for your attention.
      </Typography>
      <Stack>
        {NOTIFICATION_LABELS.map(([key, label]) => {
          const included =
            key !== "allMessages" && preferences.notifications.allMessages;
          return (
            <FormControlLabel
              key={key}
              control={
                <Checkbox
                  checked={preferences.notifications[key]}
                  disabled={included}
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
              label={included ? `${label} (Included by All Messages)` : label}
            />
          );
        })}
      </Stack>
      <Alert
        severity={pushState.kind === "active" ? "success" : "info"}
        sx={{ mt: 2 }}
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
          <Button variant="outlined" disabled={pushBusy} onClick={onEnablePush}>
            Enable Browser Push
          </Button>
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
    const result = await validateModel.mutateAsync();
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
      <Typography fontWeight={700}>Pinned Claude model versions</Typography>
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
                <Typography variant="caption" color={model.availability === "unavailable" ? "warning.main" : "success.main"}>
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
            onChange={event => setModelId(event.target.value)}
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
  validationProjectId,
  modelCatalogLoading,
  onPreferences,
  onToggleEngine,
}: {
  preferences: WorkspacePreferencesDto;
  engines: EngineDto[];
  updatePending: boolean;
  validationProjectId?: string;
  modelCatalogLoading: boolean;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onToggleEngine(engineId: string, enabled: boolean): void;
}): JSX.Element {
  return (
    <Stack spacing={2}>
      {engines.length === 0 ? (
        <Alert severity="info">
          No AI providers are registered yet. Install and authenticate Codex or
          Claude Code on this host, then refresh Ponderosa.
        </Alert>
      ) : null}
      {engines.map(engine => {
        const resolved = resolveRuntimeSelection(engine, preferences);
        const modelState = runtimeControlState(engine, resolved);
        const efforts = effortOptionsForModel(engine, resolved.model);
        return (
          <Paper key={engine.id} variant="outlined" sx={{ p: 2.5 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={engine.enabled !== false}
                  disabled={updatePending}
                  onChange={(_, enabled) => onToggleEngine(engine.id, enabled)}
                />
              }
              label={
                <Box>
                  <Typography fontWeight={800}>{engine.displayName}</Typography>
                  <Typography
                    variant="caption"
                    color={engine.available ? "text.secondary" : "warning.main"}
                  >
                    {engine.available
                      ? "Available"
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
                  Default Model
                </InputLabel>
                <Select
                  labelId={`settings-model-${engine.id}`}
                  label="Default Model"
                  value={resolved.model}
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
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id={`settings-effort-${engine.id}`}>
                  Default Reasoning
                </InputLabel>
                <Select
                  labelId={`settings-effort-${engine.id}`}
                  label="Default Reasoning"
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
            {!engineIsAvailable(engine) ? (
              <Alert severity="warning" sx={{ mt: 2 }}>
                This provider needs attention before it can start new work.
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
  section = "general",
}: {
  preferences: WorkspacePreferencesDto;
  engines: EngineDto[];
  projects: ProjectDto[];
  colorMode: ColorMode;
  onToggleColorMode(): void;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  section?: "general" | "providers" | "notifications";
}): JSX.Element {
  const queryClient = useQueryClient();
  const validationProject = projects[0];
  const modelCatalogQuery = useQuery({
    queryKey: queryKeys.engines.models(validationProject?.id, "claude"),
    queryFn: () => api.getEngineModels(validationProject!.id, "claude"),
    enabled: Boolean(validationProject && engines.some((engine) => engine.id === "claude")),
    staleTime: 5 * 60_000,
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
  const [pushState, setPushState] = useState<WebPushState>({
    kind: "permission_default",
    message: "Checking browser push status…",
  });
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    void inspectWebPush().then(setPushState);
  }, []);
  useEffect(() => {
    setInstructions(preferences.globalInstructions);
    setLimit(String(preferences.maxConcurrentAgentRuns));
    setRolloverTokens(String(preferences.contextRolloverTokens));
    setRolloverFraction(String(preferences.contextRolloverWindowFraction));
  }, [
    preferences.contextRolloverTokens,
    preferences.contextRolloverWindowFraction,
    preferences.globalInstructions,
    preferences.maxConcurrentAgentRuns,
  ]);
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
  const saveAgentDefaults = useMutation({
    mutationFn: (patch: {
      globalInstructions: string;
      maxConcurrentAgentRuns: number;
    }) => api.updateWorkspacePreferences(patch),
    onSuccess: updated => {
      queryClient.setQueryData<WorkspacePreferencesDto>(
        queryKeys.workspacePreferences.all,
        updated,
      );
    },
  });
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
              setInstructions(value);
            }}
            onLimit={value => {
              saveAgentDefaults.reset();
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
            onRolloverTokens={setRolloverTokens}
            onRolloverFraction={setRolloverFraction}
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
            validationProjectId={validationProject?.id}
            modelCatalogLoading={modelCatalogQuery.isLoading}
            onPreferences={onPreferences}
            onToggleEngine={(engineId, enabled) =>
              updateEngine.mutate({ engineId, enabled })
            }
          />
        ) : null}
      </Box>
    </Box>
  );
}

export function OperatorProfileWorkspace({
  preferences,
  onPreferences,
}: {
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const form = useOperatorProfileForm(preferences.profile);
  return (
    <Box className="ponderosa-scroll" sx={{ minHeight: 0, overflow: "auto" }}>
      <SettingsHeader profile />
      <Box sx={{ maxWidth: 720, mx: "auto", p: { xs: 2, md: 4 } }}>
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
          <OperatorProfileEditor
            form={form}
            avatarSize={72}
            nameLabel="What Agents Call You"
            handleHelperText="Used as your stable #handle. Historical structured mentions continue to follow this identity."
            pictureLabelId="profile-picture"
            avatarFirst
            showDescription
          />
          <Button
            variant="contained"
            disabled={form.busy || !form.valid}
            onClick={() => onPreferences({ profile: form.profile })}
            sx={{ alignSelf: "flex-start", mt: 2.25 }}
          >
            Save Profile
          </Button>
        </Paper>
      </Box>
    </Box>
  );
}
