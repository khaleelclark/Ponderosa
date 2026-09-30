import { Alert, Box, Chip, Stack, Typography } from "@mui/material";
import type { TokenUsageSummaryDto } from "@ponderosa/core";

function formatTokens(value = 0): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(value = 0): string {
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function runsLabel(value: number): string {
  return `${value} run${value === 1 ? "" : "s"}`;
}

function metricLabel(key: string): string {
  if (key === "inputTokens") return "Input";
  if (key === "cachedInputTokens") return "Cached Input";
  if (key === "cacheWriteInputTokens") return "Cache Writes";
  if (key === "outputTokens") return "Output";
  if (key === "reasoningOutputTokens") return "Reasoning Output";
  return "Total";
}

export function TokenUsageDetails({ data }: { data: TokenUsageSummaryDto }): JSX.Element {
  const providerUsage = [...(data.breakdown ?? []).reduce((providers, item) => {
    const current = providers.get(item.engine) ?? { engine: item.engine, runs: 0, totalTokens: 0, models: new Set<string>() };
    current.runs += item.runs;
    current.totalTokens += item.usage.totalTokens ?? 0;
    if (item.model) current.models.add(item.model);
    providers.set(item.engine, current);
    return providers;
  }, new Map<string, { engine: string; runs: number; totalTokens: number; models: Set<string> }>()).values()];
  return <Stack spacing={2.5}>
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Token Usage</Typography>
      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
        {(["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const).map((key) => <Box key={key} sx={{ minWidth: 100 }}><Typography variant="caption" color="text.secondary">{metricLabel(key)}</Typography><Typography variant="body2">{(data.metricAvailability?.[key] ?? (data[key] === undefined ? "unavailable" : "available")) === "available" ? formatTokens(data[key]) : "Unavailable"}</Typography></Box>)}
      </Stack>
    </Box>
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Run Telemetry</Typography>
      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
        <Box><Typography variant="caption" color="text.secondary">Finalized Runs</Typography><Typography variant="body2">{data.finalizedRuns}</Typography></Box>
        <Box><Typography variant="caption" color="text.secondary">Provider Requests</Typography><Typography variant="body2">{data.providerRequests ?? "Unavailable"}</Typography></Box>
        <Box><Typography variant="caption" color="text.secondary">Aggregate Run Time</Typography><Typography variant="body2">{data.durationMs === undefined ? "Unavailable" : formatDuration(data.durationMs)}</Typography></Box>
        <Box><Typography variant="caption" color="text.secondary">Usage Coverage</Typography><Typography variant="body2">{data.coverage === null ? "No Runs" : `${Math.round(data.coverage * 100)}%`}</Typography></Box>
      </Stack>
    </Box>
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>Usage by Provider</Typography>
      {providerUsage.length ? <Stack spacing={1}>{providerUsage.map((provider) => <Stack key={provider.engine} direction="row" spacing={2} sx={{ alignItems: "baseline", justifyContent: "space-between" }}><Box><Typography variant="body2" sx={{ textTransform: "capitalize", fontWeight: 700 }}>{provider.engine}</Typography><Typography variant="caption" color="text.secondary">{provider.models.size ? [...provider.models].join(", ") : "Runtime default"}</Typography></Box><Box sx={{ textAlign: "right" }}><Typography variant="body2">{formatTokens(provider.totalTokens)} tokens</Typography><Typography variant="caption" color="text.secondary">{runsLabel(provider.runs)}</Typography></Box></Stack>)}</Stack> : <Typography variant="body2" color="text.secondary">No provider has reported usage in this range.</Typography>}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>These are tokens reported for this Run. Provider-account limits, when supported, appear in Provider usage. Token counts are not a cost estimate.</Typography>
    </Box>
    <Alert severity={data.unreportedRuns ? "warning" : "info"}>Provider usage was reported for {data.reportedRuns} of {data.finalizedRuns} finalized Runs.{data.unreportedRuns ? ` ${data.unreportedRuns} older or unsupported Runs have no usage data.` : ""}</Alert>
    {data.wakeCauses.length ? <Box><Typography variant="subtitle2" sx={{ mb: 0.75 }}>Why Runs Started</Typography><Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">{data.wakeCauses.map((item) => <Chip key={item.cause} size="small" variant="outlined" label={`${item.cause.replaceAll("_", " ")} · ${item.runs} ${item.runs === 1 ? "Run" : "Runs"}${item.activations !== item.runs ? ` · ${item.activations} wake-ups` : ""}`} />)}</Stack></Box> : null}
    {data.breakdown?.length ? <Box><Typography variant="subtitle2" sx={{ mb: 1 }}>Usage by Chat and Agent</Typography>{data.breakdown.map((item) => <Stack key={`${item.projectId}:${item.conversationId ?? ""}:${item.agentId}:${item.engine}:${item.model ?? ""}`} direction="row" justifyContent="space-between" spacing={2} sx={{ py: .5 }}><Typography variant="body2" noWrap>{item.agentTitle} · {item.engine}{item.model ? ` / ${item.model}` : ""} · {runsLabel(item.runs)}</Typography><Typography variant="caption" color="text.secondary">{formatTokens(item.usage.totalTokens)} tokens</Typography></Stack>)}</Box> : null}
    <Typography variant="caption" color="text.secondary">Input can include instructions, tool definitions, conversation context, and cached reuse. Cached input is shown separately where the provider reports it, so experiment comparisons can distinguish reuse from new context.</Typography>
  </Stack>;
}
