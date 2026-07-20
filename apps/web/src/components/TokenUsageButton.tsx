import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, IconButton, InputLabel, LinearProgress, MenuItem, Select, Stack, Tooltip, Typography } from "@mui/material";
import type { ProjectedApiCostComponentsDto, TokenUsageRangeDto, TokenUsageScope, TokenUsageSummaryDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

export function formatTokens(value = 0): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatUsd(value = 0): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: value < 0.01 ? 6 : 2 }).format(value);
}

export function costSummaryLabel(data?: TokenUsageSummaryDto): string {
  if (!data) return "Cost";
  const cost = data.projectedApiCost;
  if (!cost || cost.pricedRuns === 0) return "Cost unavailable";
  return cost.unpricedRuns > 0 ? `Partial · ${formatUsd(cost.usd)}` : formatUsd(cost.usd);
}

export function providerUsageSummaryLabel(engineId: string, data?: TokenUsageSummaryDto, loading = false): string {
  if (loading) return "Provider-reported usage: checking Ponderosa Run telemetry…";
  const usage = data?.breakdown.filter((item) => item.engine === engineId);
  const runs = usage?.reduce((total, item) => total + item.runs, 0) ?? 0;
  if (runs === 0) return "Provider-reported usage: unknown — no Run telemetry is available for this provider.";
  const tokens = usage?.reduce((total, item) => total + (item.usage.totalTokens ?? 0), 0) ?? 0;
  return `Provider-reported usage: ${new Intl.NumberFormat().format(tokens)} tokens across ${runs} finalized Run${runs === 1 ? "" : "s"}.`;
}

function runsLabel(value: number): string {
  return `${value} run${value === 1 ? "" : "s"}`;
}

const COST_COMPONENTS: Array<{ key: keyof ProjectedApiCostComponentsDto; label: string }> = [
  { key: "uncachedInput", label: "New input" },
  { key: "cachedInput", label: "Cached input" },
  { key: "cacheWriteInput", label: "Cache writes" },
  { key: "output", label: "Output" },
];

function CostComponents({ components, compact = false }: { components: ProjectedApiCostComponentsDto; compact?: boolean }): JSX.Element {
  return <Stack direction={compact ? "column" : "row"} spacing={compact ? 0.5 : 2} useFlexGap flexWrap="wrap">
    {COST_COMPONENTS.map(({ key, label }) => <Box key={key} sx={{ minWidth: compact ? 0 : 92 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant={compact ? "body2" : "h6"}>{formatUsd(components[key].usd)}</Typography>
      <Typography variant="caption" color="text.secondary">{formatTokens(components[key].tokens)} tokens</Typography>
    </Box>)}
  </Stack>;
}

export function TokenUsageDetails({ data }: { data: TokenUsageSummaryDto }): JSX.Element {
  const cost = data.projectedApiCost;
  const hasPricedRuns = Boolean(cost?.pricedRuns);
  const isPartialEstimate = Boolean(cost?.pricedRuns && cost.unpricedRuns);
  const providerUsage = [...(data.breakdown ?? []).reduce((providers, item) => {
    const current = providers.get(item.engine) ?? { engine: item.engine, runs: 0, reportedRuns: 0, totalTokens: 0, models: new Set<string>() };
    current.runs += item.runs;
    current.reportedRuns += item.runs - item.unpricedRuns;
    current.totalTokens += item.usage.totalTokens ?? 0;
    if (item.model) current.models.add(item.model);
    providers.set(item.engine, current);
    return providers;
  }, new Map<string, { engine: string; runs: number; reportedRuns: number; totalTokens: number; models: Set<string> }>()).values()];
  return <Stack spacing={2}>
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Token usage</Typography>
      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
        {(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const).map((key) => <Box key={key} sx={{ minWidth: 100 }}>
          <Typography variant="caption" color="text.secondary">{key.replace(/Tokens$/, "").replace(/([A-Z])/g, " $1").trim()}</Typography>
          <Typography variant="body2">{(data.metricAvailability?.[key] ?? (data[key] === undefined ? "unavailable" : "available")) === "available" ? formatTokens(data[key]) : "Unavailable"}</Typography>
        </Box>)}
      </Stack>
    </Box>
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Usage by provider</Typography>
      {providerUsage.length ? <Stack spacing={1}>
        {providerUsage.map((provider) => <Stack key={provider.engine} direction="row" spacing={2} sx={{ alignItems: "baseline", justifyContent: "space-between" }}>
          <Box><Typography variant="body2" sx={{ textTransform: "capitalize", fontWeight: 700 }}>{provider.engine}</Typography><Typography variant="caption" color="text.secondary">{provider.models.size ? [...provider.models].join(", ") : "Runtime default"} · provider-reported telemetry</Typography></Box>
          <Box sx={{ textAlign: "right" }}><Typography variant="body2">{formatTokens(provider.totalTokens)} tokens</Typography><Typography variant="caption" color="text.secondary">{provider.runs} finalized run{provider.runs === 1 ? "" : "s"}</Typography></Box>
        </Stack>)}
      </Stack> : <Typography variant="body2" color="text.secondary">No provider has reported usage in this range.</Typography>}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>Ponderosa does not read subscription quotas, invoices, or provider account usage.</Typography>
    </Box>
    {cost && hasPricedRuns ? <>
      <Box>
        <Typography variant="h4" component="p">{formatUsd(cost.usd)}</Typography>
        <Typography variant="body2" color="text.secondary">
          {isPartialEstimate ? "Partial estimate · " : ""}projected API-equivalent list price · not a subscription bill
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Priced {cost.pricedRuns} of {data.finalizedRuns} finalized runs using catalog {cost.catalogVersion}.
        </Typography>
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Cost by token type</Typography>
        <CostComponents components={cost.components} />
      </Box>
      <Box>
        <Typography variant="subtitle2">Cost by model</Typography>
        {cost.breakdown.map((item) => <Box key={`${item.engine}:${item.requestedModel ?? "default"}:${item.pricingModel}`} sx={{ mt: 1.5, pb: 1.5, borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0, pb: 0 } }}>
          <Stack direction="row" justifyContent="space-between" spacing={2}>
            <Box>
              <Typography variant="body2">{item.requestedModel || `${item.engine} default`} → {item.pricingModel}{item.proxy ? " proxy" : ""}</Typography>
              <Typography variant="caption" color="text.secondary">{runsLabel(item.runs)}</Typography>
            </Box>
            <Typography variant="body2" fontWeight={600}>{formatUsd(item.usd)}</Typography>
          </Stack>
          <Box sx={{ mt: 0.5 }}><CostComponents components={item.components} compact /></Box>
        </Box>)}
      </Box>
    </> : <Alert severity="warning">Cost unavailable. No finalized runs in this scope have enough recognized model pricing and request-level usage detail for a defensible estimate.</Alert>}
    <Alert severity={data.unreportedRuns || cost?.unpricedRuns ? "warning" : "info"}>
      Provider usage was reported for {data.reportedRuns} of {data.finalizedRuns} finalized runs. {cost ? `${runsLabel(cost.pricedRuns)} ${cost.pricedRuns === 1 ? "has" : "have"} a recognized model price.` : "No recognized model prices are available."}
      {data.unreportedRuns ? ` ${data.unreportedRuns} older or unsupported runs have no usage data.` : ""}
      {cost?.unpricedRuns ? ` ${runsLabel(cost.unpricedRuns)} ${cost.unpricedRuns === 1 ? "is" : "are"} excluded because model pricing, usage, or request-level detail required for long-context pricing is unavailable.` : ""}
    </Alert>
    {data.wakeCauses.length ? <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.75 }}>Why Runs started</Typography>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        {data.wakeCauses.map((item) => <Chip key={item.cause} size="small" variant="outlined" label={`${item.cause.replaceAll("_", " ")} · ${item.runs} ${item.runs === 1 ? "Run" : "Runs"}${item.activations !== item.runs ? ` · ${item.activations} wake-ups` : ""}`} />)}
      </Stack>
      <Typography variant="caption" color="text.secondary">Exact Activation kinds attached by the scheduler. A coalesced Run may appear in more than one category; inspect its full trace in Agent work.</Typography>
    </Box> : null}
    {data.breakdown?.length ? <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Usage by chat and agent</Typography>
      {data.breakdown.map((item) => <Stack key={`${item.projectId}:${item.conversationId ?? ""}:${item.agentId}:${item.engine}:${item.model ?? ""}`} direction="row" justifyContent="space-between" spacing={2} sx={{ py: .5 }}>
        <Typography variant="body2" noWrap>{item.agentTitle} · {item.engine}{item.model ? ` / ${item.model}` : ""} · {runsLabel(item.runs)}</Typography>
        <Typography variant="caption" color="text.secondary">{item.estimatedCostUsd === undefined ? "Estimate unavailable" : formatUsd(item.estimatedCostUsd)}</Typography>
      </Stack>)}
    </Box> : null}
    <Typography variant="caption" color="text.secondary">
      New input is calculated as provider input minus cached reads and cache writes, so no token is charged twice. Reasoning is included in output. Long-context tiers are applied per provider request; aggregate-only runs that could cross a tier are excluded. Current public API list prices are used, while subscription terms and tool fees are excluded.
    </Typography>
  </Stack>;
}

export function TokenUsageButton({ scope, scopeId, label, compact = false }: { scope: TokenUsageScope; scopeId?: string; label: string; compact?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [rangeKey, setRangeKey] = useState<"all" | "24h" | "7d" | "30d">("30d");
  const range: TokenUsageRangeDto = rangeKey === "all" ? {} : { from: new Date(Date.now() - ({ "24h": 24, "7d": 24 * 7, "30d": 24 * 30 }[rangeKey] ?? 0) * 60 * 60 * 1000).toISOString() };
  const usage = useQuery({
    queryKey: ["token-usage", scope, scopeId, rangeKey],
    queryFn: () => api.getTokenUsage(scope, scopeId, range),
    enabled: scope === "overall" || Boolean(scopeId),
    refetchInterval: open ? 5_000 : 30_000,
  });
  const data = usage.data;
  const costLabel = costSummaryLabel(data);
  const usageLabel = data?.reportedRuns ? `${formatTokens(data.totalTokens)} tokens` : "Usage";
  return <>
    {compact ? <Tooltip title={`${label} usage · ${usageLabel} · ${costLabel}`}>
      <IconButton onClick={() => setOpen(true)} aria-label={`${label} usage`} sx={{ minWidth: 44, minHeight: 44 }}>
        <DataUsageOutlinedIcon />
      </IconButton>
    </Tooltip> : <Button
        size="small"
        variant="outlined"
        startIcon={<DataUsageOutlinedIcon />}
        onClick={() => setOpen(true)}
        aria-label={`${label} usage`}
        sx={{ whiteSpace: "nowrap", minHeight: 36 }}
      >
        {usageLabel}
      </Button>}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" aria-labelledby={`${scope}-usage-title`} PaperProps={{ sx: { width: { xs: "calc(100% - 16px)", sm: 720 }, maxHeight: "calc(100dvh - 16px)", m: { xs: 1, sm: 4 } } }}>
      <DialogTitle id={`${scope}-usage-title`}>{label} usage</DialogTitle>
      <DialogContent>
        <FormControl size="small" sx={{ minWidth: 150, mb: 2 }}>
          <InputLabel id={`${scope}-usage-range-label`}>Time range</InputLabel>
          <Select labelId={`${scope}-usage-range-label`} label="Time range" value={rangeKey} onChange={(event) => setRangeKey(event.target.value as typeof rangeKey)}>
            <MenuItem value="24h">Last 24 Hours</MenuItem>
            <MenuItem value="7d">Last 7 Days</MenuItem>
            <MenuItem value="30d">Last 30 Days</MenuItem>
            <MenuItem value="all">All Time</MenuItem>
          </Select>
        </FormControl>
        {usage.isError ? <Alert severity="error">Cost could not be loaded.</Alert> : !data ? <LinearProgress /> : <TokenUsageDetails data={data} />}
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
