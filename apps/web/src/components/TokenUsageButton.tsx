import DataUsageOutlinedIcon from "@mui/icons-material/DataUsageOutlined";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress, Stack, Tooltip, Typography } from "@mui/material";
import type { TokenUsageScope, TokenUsageSummaryDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

export function formatTokens(value = 0): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function TokenUsageDetails({ data }: { data: TokenUsageSummaryDto }): JSX.Element {
  return <Stack spacing={2}>
    <Box>
      <Typography variant="h4" component="p">{formatTokens(data.totalTokens)}</Typography>
      <Typography variant="body2" color="text.secondary">provider-reported tokens processed</Typography>
    </Box>
    <Stack direction="row" spacing={3} useFlexGap flexWrap="wrap">
      <Box><Typography variant="caption" color="text.secondary">Input</Typography><Typography>{formatTokens(data.inputTokens)}</Typography></Box>
      <Box><Typography variant="caption" color="text.secondary">Output</Typography><Typography>{formatTokens(data.outputTokens)}</Typography></Box>
      <Box><Typography variant="caption" color="text.secondary">Cached input</Typography><Typography>{formatTokens(data.cachedInputTokens)}</Typography></Box>
      <Box><Typography variant="caption" color="text.secondary">Reasoning output</Typography><Typography>{formatTokens(data.reasoningOutputTokens)}</Typography></Box>
    </Stack>
    <Alert severity={data.unreportedRuns ? "warning" : "info"}>
      Usage reported for {data.reportedRuns} of {data.finalizedRuns} finalized runs
      {data.unreportedRuns ? `. ${data.unreportedRuns} older or unsupported runs are excluded.` : "."}
    </Alert>
    <Typography variant="caption" color="text.secondary">
      Cached input is already included in input tokens. These are provider token counts, not compute time or cost.
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
    {compact ? <Tooltip title={`${label} token usage${data ? ` · ${formatTokens(data.totalTokens)} tokens` : ""}`}>
      <IconButton onClick={() => setOpen(true)} aria-label={`${label} token usage`} sx={{ minWidth: 44, minHeight: 44 }}>
        <DataUsageOutlinedIcon />
      </IconButton>
    </Tooltip> : <Button
        size="small"
        variant="outlined"
        startIcon={<DataUsageOutlinedIcon />}
        onClick={() => setOpen(true)}
        aria-label={`${label} token usage`}
        sx={{ whiteSpace: "nowrap", minHeight: 36 }}
      >
        {data ? `${formatTokens(data.totalTokens)} tokens` : "Usage"}
      </Button>}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs" aria-labelledby={`${scope}-usage-title`}>
      <DialogTitle id={`${scope}-usage-title`}>{label} token usage</DialogTitle>
      <DialogContent>
        {usage.isError ? <Alert severity="error">Token usage could not be loaded.</Alert> : !data ? <LinearProgress /> : <TokenUsageDetails data={data} />}
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
