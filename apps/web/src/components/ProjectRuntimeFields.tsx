import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
} from "@mui/material";
import type { EngineDto } from "@ponderosa/core";
import {
  runtimeControlState,
  type RuntimeSelection,
} from "../conversationEngine";

export function ProjectRuntimeFields({
  engine,
  inherited,
  model,
  effort,
  onChange,
  modelLabel,
  effortLabel,
  modelLabelId,
  effortLabelId,
  inheritedPrefix,
  inheritedFallback = "",
  disabled = false,
}: {
  engine?: EngineDto;
  inherited: RuntimeSelection;
  model: string;
  effort: string;
  onChange(selection: RuntimeSelection): void;
  modelLabel: string;
  effortLabel: string;
  modelLabelId: string;
  effortLabelId: string;
  inheritedPrefix: string;
  inheritedFallback?: string;
  disabled?: boolean;
}): JSX.Element {
  const state = runtimeControlState(engine, {
    model: model || inherited.model,
    effort: effort || inherited.effort,
  });
  const inheritedModelLabel = state.models.find((option) => option.id === inherited.model)?.label
    ?? inherited.model
    ?? inheritedFallback;
  const inheritedEffortLabel = state.efforts.find((option) => option.id === inherited.effort)?.label
    ?? inherited.effort
    ?? inheritedFallback;

  return <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
    <FormControl fullWidth disabled={disabled}>
      <InputLabel id={modelLabelId}>{modelLabel}</InputLabel>
      <Select
        labelId={modelLabelId}
        label={modelLabel}
        value={model}
        onChange={(event) => onChange({ model: event.target.value, effort: "" })}
      >
        <MenuItem value="">{inheritedPrefix} — {inheritedModelLabel || inheritedFallback}</MenuItem>
        {state.models.map((option) => <MenuItem key={option.id} value={option.id} disabled={option.disabled}>{option.label}</MenuItem>)}
      </Select>
    </FormControl>
    <FormControl fullWidth disabled={disabled}>
      <InputLabel id={effortLabelId}>{effortLabel}</InputLabel>
      <Select
        labelId={effortLabelId}
        label={effortLabel}
        value={effort}
        onChange={(event) => onChange({ model, effort: event.target.value })}
      >
        <MenuItem value="">{inheritedPrefix} — {inheritedEffortLabel || inheritedFallback}</MenuItem>
        {state.efforts.map((option) => <MenuItem key={option.id} value={option.id} disabled={option.disabled}>{option.label}</MenuItem>)}
      </Select>
    </FormControl>
  </Stack>;
}
