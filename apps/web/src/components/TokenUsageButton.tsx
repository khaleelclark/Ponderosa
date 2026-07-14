import PaidOutlinedIcon from "@mui/icons-material/PaidOutlined";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import type { ProjectedApiCostComponentsDto, TokenUsageScope, TokenUsageSummaryDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

export function formatTokens(value = 0): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatUsd(value = 0): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: value < 0.01 ? 6 : 2 }).format(value);
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
  return <Stack spacing={2}>
    {cost ? <>
      <Box>
        <Typography variant="h4" component="p">{formatUsd(cost.usd)}</Typography>
      <Typography variant="body2" color="text.secondary">projected API-equivalent list price · not a subscription bill</Typography>
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
    </> : <Alert severity="warning">No runs in this scope can be priced yet.</Alert>}
    <Alert severity={data.unreportedRuns || cost?.unpricedRuns ? "warning" : "info"}>
      Provider usage was reported for {data.reportedRuns} of {data.finalizedRuns} finalized runs. {cost ? `${runsLabel(cost.pricedRuns)} ${cost.pricedRuns === 1 ? "has" : "have"} a recognized model price.` : "No recognized model prices are available."}
      {data.unreportedRuns ? ` ${data.unreportedRuns} older or unsupported runs have no usage data.` : ""}
      {cost?.unpricedRuns ? ` ${runsLabel(cost.unpricedRuns)} ${cost.unpricedRuns === 1 ? "is" : "are"} excluded from cost because usage or model pricing is unavailable.` : ""}
    </Alert>
    <Typography variant="caption" color="text.secondary">
      New input is calculated as provider input minus cached reads and cache writes, so no token is charged twice. Reasoning is included in output. Costs are summed per run using that run's model and current public API list-price proxy; subscription terms and tool fees are excluded.
    </Typography>
  </Stack>;
}

export function TokenUsageButton({ scope, scopeId, label, compact = false }: { scope: TokenUsageScope; scopeId?: string; label: string; compact?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const usage = useQuery({
    queryKey: ["token-usage", scope, scopeId],
    queryFn: () => api.getTokenUsage(scope, scopeId),
    enabled: scope === "overall" || Boolean(scopeId),
    refetchInterval: open ? 5_000 : 30_000,
  });
  const data = usage.data;
  return <>
    {compact ? <Tooltip title={`${label} projected cost${data?.projectedApiCost ? ` · ${formatUsd(data.projectedApiCost.usd)}` : ""}`}>
      <IconButton onClick={() => setOpen(true)} aria-label={`${label} projected cost`} sx={{ minWidth: 44, minHeight: 44 }}>
        <PaidOutlinedIcon />
      </IconButton>
    </Tooltip> : <Button
        size="small"
        variant="outlined"
        startIcon={<PaidOutlinedIcon />}
        onClick={() => setOpen(true)}
        aria-label={`${label} projected cost`}
        sx={{ whiteSpace: "nowrap", minHeight: 36 }}
      >
        {data?.projectedApiCost ? formatUsd(data.projectedApiCost.usd) : "Cost"}
      </Button>}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs" aria-labelledby={`${scope}-usage-title`}>
      <DialogTitle id={`${scope}-usage-title`}>{label} cost</DialogTitle>
      <DialogContent>
        {usage.isError ? <Alert severity="error">Cost could not be loaded.</Alert> : !data ? <LinearProgress /> : <TokenUsageDetails data={data} />}
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
