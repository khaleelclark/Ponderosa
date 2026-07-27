import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Paper,
  Popover,
  Stack,
  Typography,
} from "@mui/material";
import type {
  ProviderUsageCenterDto,
  ProviderUsageStateDto,
  ProviderUsageWindow,
} from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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

export function ProviderUsageCard({
  state,
  onRefresh,
  onClose,
  compact = false,
}: {
  state: ProviderUsageStateDto;
  onRefresh?: () => void;
  onClose?: () => void;
  compact?: boolean;
}): JSX.Element {
  const now = useClock();
  const reading = state.reading;
  return (
    <Paper
      variant="outlined"
      aria-live="polite"
      sx={{ p: compact ? 1.5 : 2, minWidth: 0 }}
    >
      <Stack direction="row" justifyContent="space-between" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography variant="subtitle2" fontWeight={800}>{state.displayName} quota</Typography>
            {state.refreshing ? <CircularProgress size={14} aria-label={`Refreshing ${state.displayName} usage`} /> : null}
          </Stack>
          {reading?.accountLabel ? (
            <Typography variant="caption" color="text.secondary" noWrap>{reading.accountLabel}</Typography>
          ) : null}
        </Box>
        <Stack direction="row" spacing={0.5}>
          {onRefresh ? (
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              disabled={state.refreshing || !state.authenticated}
              onClick={onRefresh}
            >
              {state.refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null}
          {onClose ? <Button size="small" onClick={onClose}>Close</Button> : null}
        </Stack>
      </Stack>

      {!state.authenticated ? (
        <Alert severity="warning" sx={{ mt: 1.25 }}>This provider is not authenticated.</Alert>
      ) : !reading && state.refreshing ? (
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", py: 2 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading subscription usage…</Typography>
        </Stack>
      ) : !reading && state.error ? (
        <Alert severity="error" sx={{ mt: 1.25 }}>{state.error}</Alert>
      ) : !reading ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No quota reading has been fetched yet.
        </Typography>
      ) : (
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
              {reading.stale ? " · stale" : ""}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {reading.source === "provider-command" ? "Subscription CLI command" : "Subscription CLI RPC"}
            </Typography>
          </Stack>
          {state.error ? (
            <Alert severity="warning" sx={{ mt: 1.25 }}>
              Refresh failed: {state.error}. Showing the last successful reading.
            </Alert>
          ) : null}
        </>
      )}
    </Paper>
  );
}

function constrainedProvider(providers: ProviderUsageStateDto[]): ProviderUsageStateDto | undefined {
  return providers
    .filter((provider) => provider.authenticated)
    .sort((left, right) => {
      const leftUsed = Math.max(-1, ...(left.reading?.windows.map((window) => window.usedPercent ?? -1) ?? [-1]));
      const rightUsed = Math.max(-1, ...(right.reading?.windows.map((window) => window.usedPercent ?? -1) ?? [-1]));
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
}: {
  preferredProvider?: string;
  mobile?: boolean;
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
  const authenticated = useMemo(
    () => (query.data?.providers ?? []).filter((provider) => provider.authenticated),
    [query.data],
  );
  useEffect(() => {
    setSelectedProvider(undefined);
  }, [preferredProvider]);
  const constrained = constrainedProvider(authenticated);
  const selected = authenticated.find((provider) => provider.provider === selectedProvider)
    ?? authenticated.find((provider) => provider.provider === preferredProvider)
    ?? constrained;
  const maximum = selected?.reading
    ? Math.max(...selected.reading.windows.map((window) => window.usedPercent ?? -1))
    : undefined;
  const label = selected
    ? maximum !== undefined && maximum >= 0
      ? `${selected.displayName} · ${Math.round(maximum)}%`
      : selected.refreshing
        ? `${selected.displayName} · loading`
        : "Quota"
    : query.isLoading ? "Quota" : "Quota unavailable";

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

  return (
    <>
      <Chip
        size="small"
        variant="outlined"
        label={label}
        icon={constrained?.refreshing ? <CircularProgress size={13} /> : undefined}
        aria-label={`${label}. Open provider quota`}
        onClick={(event) => open(event.currentTarget)}
        sx={{
          cursor: "pointer",
          maxWidth: mobile ? 150 : 170,
          color: mobile ? undefined : "var(--ponderosa-rail-foreground)",
          borderColor: mobile ? undefined : "var(--ponderosa-rail-border)",
          "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
        }}
      />
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(undefined)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: "min(420px, calc(100vw - 24px))", mt: 1 } } }}
      >
        <Box sx={{ p: 1.5 }}>
          <Typography variant="overline" color="text.secondary">Provider quota</Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mb: 1.25 }}>
            {[...authenticated]
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
              compact
            />
          ) : (
            <Alert severity="info">No authenticated provider exposes subscription usage.</Alert>
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
