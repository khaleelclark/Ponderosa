import { Stack, TextField, Typography } from "@mui/material";

const MIN_AGENT_RUN_CONCURRENCY = 1;
const MAX_AGENT_RUN_CONCURRENCY = 64;

export function parseAgentRunConcurrencyLimit(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_AGENT_RUN_CONCURRENCY && parsed <= MAX_AGENT_RUN_CONCURRENCY
    ? parsed
    : undefined;
}

export function RuntimeSettings({ value, onChange }: { value: string; onChange(value: string): void }): JSX.Element {
  const valid = parseAgentRunConcurrencyLimit(value) !== undefined;
  return <Stack spacing={1}>
    <Typography variant="subtitle2">Runtime</Typography>
    <TextField
      label="Maximum concurrent Agent Runs"
      type="number"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={!valid}
      helperText={valid
        ? "Applies across Ponderosa immediately. Active Runs finish normally; queued work keeps its scheduler order."
        : `Enter a whole number from ${MIN_AGENT_RUN_CONCURRENCY} to ${MAX_AGENT_RUN_CONCURRENCY}.`}
      inputProps={{ min: MIN_AGENT_RUN_CONCURRENCY, max: MAX_AGENT_RUN_CONCURRENCY, step: 1 }}
      fullWidth
    />
    <Typography variant="caption" color="text.secondary">
      Technical byte, page, time, and process safety limits remain system-managed.
    </Typography>
  </Stack>;
}
