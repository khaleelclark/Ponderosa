import RefreshIcon from "@mui/icons-material/Refresh";
import CloseIcon from "@mui/icons-material/Close";
import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Popover,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  ProviderUsageCenterDto,
  ProviderUsageFailureCode,
  ProviderUsageStateDto,
  ProviderUsageWindow,
} from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

function useClock(active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [active]);
  return now;
}

function updatedAgo(timestamp: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function resetLabel(timestamp: string): string {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

function UsageWindowRow({ window }: { window: ProviderUsageWindow }): JSX.Element {
  const reported = window.usedPercent !== undefined;
  const value = reported ? Math.max(0, Math.min(100, window.usedPercent!)) : 0;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" spacing={2} sx={{ alignItems: "baseline" }}>
        <Typography variant="body2" fontWeight={700}>{window.label}</Typography>
        <Typography variant="body2" fontWeight={800}>
          {reported ? `${Math.round(value)}% used` : "Not reported"}
        </Typography>
      </Stack>
      {reported ? (
        <LinearProgress
          variant="determinate"
          value={value}
          color={value >= 85 ? "error" : value >= 65 ? "warning" : "primary"}
          sx={{ mt: 0.75, height: 7, borderRadius: 999 }}
        />
      ) : null}
      {window.resetsAt ? (
        <Typography variant="caption" color="text.secondary">
          Resets {resetLabel(window.resetsAt)}
        </Typography>
      ) : null}
    </Box>
  );
}

function usageData(state: ProviderUsageStateDto) {
  return state.status === "fresh" || state.status === "stale" ? state.data : undefined;
}

function failureActions(code: ProviderUsageFailureCode) {
  return {
    settings: ["provider_not_installed", "provider_not_authenticated", "provider_disabled"].includes(code),
    diagnostics: ["command_timeout", "provider_rate_limited", "provider_temporarily_unavailable", "unknown_failure", "server_environment_invalid"].includes(code),
    support: code === "invalid_provider_response",
    retry: !["provider_not_installed", "provider_not_authenticated", "provider_disabled", "usage_not_supported"].includes(code),
  };
}

export function ProviderUsageCard({
  state,
  onRefresh,
  onClose,
  onOpenProviderSettings,
  compact = false,
}: {
  state: ProviderUsageStateDto;
  onRefresh?: () => void;
  onClose?: () => void;
  onOpenProviderSettings?: () => void;
  compact?: boolean;
}): JSX.Element {
  const now = useClock();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const reading = usageData(state);
  const failure = state.status === "stale" || state.status === "unavailable" ? state.failure : undefined;
  const actions = failure ? failureActions(failure.code) : undefined;
  const copySupportReport = () => {
    if (!failure) return;
    void navigator.clipboard.writeText(JSON.stringify({
      provider: state.provider,
      status: state.status,
      failure: {
        code: failure.code,
        correlationId: failure.correlationId,
        occurredAt: failure.occurredAt,
        durationMs: failure.durationMs,
        exitCode: failure.exitCode,
        timedOut: failure.timedOut,
        runtimeVersion: failure.runtimeVersion,
      },
    }, null, 2));
  };
  return (
    <Paper
      variant="outlined"
      aria-live="polite"
      sx={{ p: compact ? 1.5 : 2, minWidth: 0 }}
    >
      <Stack direction="row" justifyContent="space-between" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography variant="subtitle2" fontWeight={800}>{state.displayName} usage</Typography>
            {state.refreshing ? <CircularProgress size={14} aria-label={`Refreshing ${state.displayName} usage`} /> : null}
          </Stack>
          {reading?.accountLabel ? (
            <Typography variant="caption" color="text.secondary" noWrap>{reading.accountLabel}</Typography>
          ) : null}
        </Box>
        <Stack direction="row" spacing={0.5}>
          {onRefresh && !failure ? (
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              disabled={state.refreshing || !state.authenticated}
              onClick={onRefresh}
            >
              {state.refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null}
          {onClose ? (
            <Button size="small" aria-label="Close provider usage" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </Button>
          ) : null}
        </Stack>
      </Stack>

      {!reading && state.refreshing ? (
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", py: 2 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading subscription usage…</Typography>
        </Stack>
      ) : !reading && failure ? (
        <Alert severity={failure.code === "usage_not_supported" ? "info" : "warning"} sx={{ mt: 1.25 }}>
          {failure.code === "provider_not_authenticated"
            ? `Sign in to ${state.displayName} on the Ponderosa host.`
            : failure.message}
        </Alert>
      ) : reading ? (
        <>
          <Stack spacing={1.5} sx={{ mt: 1.5 }}>
            {reading.windows.map((window) => (
              <UsageWindowRow key={window.id} window={window} />
            ))}
          </Stack>
          <Divider sx={{ my: 1.5 }} />
          <Stack direction="row" justifyContent="space-between" spacing={2}>
            <Typography variant="caption" color="text.secondary">
              Updated {updatedAgo(reading.fetchedAt, now)}
              {state.status === "stale" ? " · stale" : ""}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {reading.source === "provider-command" ? "Subscription CLI command" : "Subscription CLI RPC"}
            </Typography>
          </Stack>
          {failure ? (
            <Alert severity="warning" sx={{ mt: 1.25 }}>
              {failure.message} Showing the last successful reading.
            </Alert>
          ) : null}
        </>
      ) : null}
      {failure && actions ? (
        <>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1.25 }}>
            {actions.settings && onOpenProviderSettings ? (
              <Button size="small" onClick={onOpenProviderSettings}>Open Provider Settings</Button>
            ) : null}
            {actions.retry && onRefresh ? (
              <Button size="small" startIcon={<RefreshIcon />} disabled={state.refreshing} onClick={onRefresh}>Try Again</Button>
            ) : null}
            {actions.diagnostics ? (
              <Button size="small" onClick={() => setDiagnosticsOpen(value => !value)}>View Diagnostics</Button>
            ) : null}
            {actions.support ? (
              <Button size="small" onClick={copySupportReport}>Copy Support Report</Button>
            ) : null}
          </Stack>
          <Collapse in={diagnosticsOpen}>
            <Box sx={{ mt: 1, p: 1, borderRadius: 1, bgcolor: "action.hover" }}>
              <Typography variant="caption" component="div">Code: {failure.code}</Typography>
              <Typography variant="caption" component="div">Reference: {failure.correlationId}</Typography>
              {failure.runtimeVersion ? <Typography variant="caption" component="div">Runtime: {failure.runtimeVersion}</Typography> : null}
              {failure.durationMs !== undefined ? <Typography variant="caption" component="div">Duration: {failure.durationMs} ms</Typography> : null}
            </Box>
          </Collapse>
        </>
      ) : null}
    </Paper>
  );
}

function constrainedProvider(providers: ProviderUsageStateDto[]): ProviderUsageStateDto | undefined {
  return providers
    .filter((provider) =>
      provider.authenticated &&
      !(provider.status === "unavailable" && provider.failure.code === "provider_disabled")
    )
    .sort((left, right) => {
      const leftUsed = Math.max(-1, ...(usageData(left)?.windows.map((window) => window.usedPercent ?? -1) ?? [-1]));
      const rightUsed = Math.max(-1, ...(usageData(right)?.windows.map((window) => window.usedPercent ?? -1) ?? [-1]));
      return rightUsed - leftUsed || left.displayName.localeCompare(right.displayName);
    })[0];
}

function mergeProvider(
  center: ProviderUsageCenterDto | undefined,
  state: ProviderUsageStateDto,
): ProviderUsageCenterDto {
  const providers = center?.providers ?? [];
  const index = providers.findIndex((candidate) => candidate.provider === state.provider);
  return {
    providers: index < 0
      ? [...providers, state]
      : providers.map((candidate, candidateIndex) => candidateIndex === index ? state : candidate),
  };
}

export function ProviderQuotaIndicator({
  preferredProvider,
  mobile = false,
  renderTrigger,
  portalTarget,
  onOpenProviderSettings,
}: {
  preferredProvider?: string;
  mobile?: boolean;
  renderTrigger?: (open: (element: HTMLElement) => void) => ReactNode;
  portalTarget?: Element | null;
  onOpenProviderSettings?: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [selectedProvider, setSelectedProvider] = useState<string>();
  const query = useQuery({
    queryKey: queryKeys.providerUsage.all,
    queryFn: () => api.getProviderUsage(),
    refetchInterval: (current) =>
      current.state.data?.providers.some((provider) => provider.refreshing) ? 1_000 : false,
    staleTime: 30_000,
  });
  const providers = useMemo(
    () => query.data?.providers ?? [],
    [query.data],
  );
  useEffect(() => {
    setSelectedProvider(undefined);
  }, [preferredProvider]);
  const constrained = constrainedProvider(providers);
  const selected = providers.find((provider) => provider.provider === selectedProvider)
    ?? providers.find((provider) => provider.provider === preferredProvider)
    ?? constrained
    ?? providers[0];
  const selectedData = selected ? usageData(selected) : undefined;
  const maximum = selectedData
    ? Math.max(...selectedData.windows.map((window) => window.usedPercent ?? -1))
    : undefined;
  const label = selected
    ? maximum !== undefined && maximum >= 0
      ? `${selected.displayName} · ${Math.round(maximum)}%`
      : selected.refreshing
        ? `${selected.displayName} · loading`
        : "Provider usage"
    : query.isLoading ? "Provider usage" : "Provider usage unavailable";
  const accessibleLabel = label === "Provider usage"
    ? "Open provider usage"
    : `Open provider usage: ${label}`;

  const open = (element: HTMLElement) => {
    setAnchor(element);
    setSelectedProvider(preferredProvider ?? constrained?.provider);
    void api.getProviderUsage(true).then((value) => {
      queryClient.setQueryData(queryKeys.providerUsage.all, value);
    });
  };
  const refresh = (providerId: string) => {
    void api.refreshProviderUsage(providerId).then((state) => {
      queryClient.setQueryData<ProviderUsageCenterDto>(
        queryKeys.providerUsage.all,
        (current) => mergeProvider(current, state),
      );
    });
  };
  useEffect(() => {
    if (!anchor) return;
    if (
      !anchor.isConnected ||
      (portalTarget !== undefined && !portalTarget?.contains(anchor))
    ) {
      setAnchor(undefined);
    }
  }, [anchor, portalTarget]);

  const trigger = renderTrigger ? renderTrigger(open) : mobile ? (
    <Tooltip title={label}>
      <IconButton
        aria-label={accessibleLabel}
        onClick={(event) => open(event.currentTarget)}
        sx={{
          position: "relative",
          flexShrink: 0,
          width: 44,
          height: 44,
        }}
      >
        <DataUsageOutlinedIcon />
        {query.isLoading || constrained?.refreshing ? (
          <CircularProgress
            size={16}
            aria-hidden
            sx={{ position: "absolute", right: 3, bottom: 3 }}
          />
        ) : null}
      </IconButton>
    </Tooltip>
  ) : (
    <Chip
      size="small"
      variant="outlined"
      label={label}
      icon={query.isLoading || constrained?.refreshing ? <CircularProgress size={13} /> : undefined}
      aria-label={accessibleLabel}
      onClick={(event) => open(event.currentTarget)}
      sx={{
        cursor: "pointer",
        maxWidth: 170,
        "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
      }}
    />
  );

  return (
    <>
      {portalTarget === null
        ? null
        : portalTarget
          ? createPortal(trigger, portalTarget)
          : trigger}
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(undefined)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              width: "min(420px, calc(100vw - 24px))",
              maxHeight: "calc(100dvh - 24px)",
              overflowY: "auto",
              mt: 1,
            },
          },
        }}
      >
        <Box sx={{ p: 1.5 }}>
          <Typography variant="overline" color="text.secondary">Provider usage</Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mb: 1.25 }}>
            {[...providers]
              .sort((left, right) =>
                Number(right.provider === preferredProvider) - Number(left.provider === preferredProvider) ||
                left.displayName.localeCompare(right.displayName)
              )
              .map((provider) => (
                <Chip
                  key={provider.provider}
                  size="small"
                  label={provider.displayName}
                  color={selected?.provider === provider.provider ? "primary" : "default"}
                  variant={selected?.provider === provider.provider ? "filled" : "outlined"}
                  onClick={() => setSelectedProvider(provider.provider)}
                />
              ))}
          </Stack>
          {selected ? (
            <ProviderUsageCard
              state={selected}
              onRefresh={() => refresh(selected.provider)}
              onClose={() => setAnchor(undefined)}
              onOpenProviderSettings={onOpenProviderSettings}
              compact
            />
          ) : (
            <Alert severity="info">No provider is configured.</Alert>
          )}
        </Box>
      </Popover>
    </>
  );
}

export function AgentProviderUsageCard({
  agentId,
  initialState,
  onClose,
}: {
  agentId: string;
  initialState: ProviderUsageStateDto;
  onClose(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.providerUsage.agent(agentId),
    queryFn: () => api.getAgentProviderUsage(agentId),
    initialData: initialState,
    refetchInterval: (current) => current.state.data?.refreshing ? 750 : false,
  });
  const state = query.data ?? initialState;
  useEffect(() => {
    queryClient.setQueryData<ProviderUsageCenterDto>(
      queryKeys.providerUsage.all,
      (current) => mergeProvider(current, state),
    );
  }, [queryClient, state]);
  return (
    <Box sx={{ mx: 1.5, mt: 1 }}>
      <ProviderUsageCard
        state={state}
        onClose={onClose}
        onOpenProviderSettings={() => globalThis.location.assign("/settings/providers")}
        onRefresh={() => {
          void api.refreshProviderUsage(state.provider).then((next) => {
            queryClient.setQueryData(queryKeys.providerUsage.agent(agentId), next);
            queryClient.setQueryData<ProviderUsageCenterDto>(
              queryKeys.providerUsage.all,
              (current) => mergeProvider(current, next),
            );
          });
        }}
      />
    </Box>
  );
}
