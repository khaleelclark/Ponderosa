import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
} from "@mui/material";
import type { SelectChangeEvent, StackProps } from "@mui/material";
import type { EngineDto } from "@ponderosa/core";
import {
  effortSelectionIsCompatible,
  runtimeControlState,
  type RuntimeControlState,
  type RuntimeSelection,
} from "../conversationEngine";

type RuntimeEmptyLabel =
  | string
  | ((state: RuntimeControlState) => string);

/** Controlled model/effort cascade for the selected runtime engine. */
export function EngineModelEffortFields({
  engine,
  selection,
  optionSelection = selection,
  onChange,
  modelLabel,
  effortLabel,
  modelLabelId,
  effortLabelId,
  modelEmptyLabel,
  effortEmptyLabel,
  disabled = false,
  size,
  runtimeDirection = "column",
  runtimeSpacing = 1.5,
  hideModelWhenEmpty = false,
  hideEffortWhenEmpty = false,
  guardSelection = true,
  resetEffortOnModelChange = "if-incompatible",
}: {
  engine?: EngineDto;
  selection: RuntimeSelection;
  optionSelection?: RuntimeSelection;
  onChange(selection: RuntimeSelection): void;
  modelLabel: string;
  effortLabel: string;
  modelLabelId?: string;
  effortLabelId?: string;
  modelEmptyLabel: RuntimeEmptyLabel;
  effortEmptyLabel: RuntimeEmptyLabel;
  disabled?: boolean;
  size?: "small" | "medium";
  runtimeDirection?: StackProps["direction"];
  runtimeSpacing?: StackProps["spacing"];
  hideModelWhenEmpty?: boolean;
  hideEffortWhenEmpty?: boolean;
  guardSelection?: boolean;
  resetEffortOnModelChange?: "always" | "if-incompatible";
}): JSX.Element | null {
  const state = runtimeControlState(engine, optionSelection);
  const showModel = !hideModelWhenEmpty || state.models.length > 0;
  const showEffort = !hideEffortWhenEmpty || state.efforts.length > 0;
  if (!showModel && !showEffort) return null;
  const modelValue = guardSelection
    ? state.models.some((option) => option.id === selection.model)
      ? selection.model
      : ""
    : selection.model;
  const effortValue = guardSelection
    ? state.efforts.some((option) => option.id === selection.effort)
      ? selection.effort
      : ""
    : selection.effort;
  const resolvedModelEmptyLabel = typeof modelEmptyLabel === "function"
    ? modelEmptyLabel(state)
    : modelEmptyLabel;
  const resolvedEffortEmptyLabel = typeof effortEmptyLabel === "function"
    ? effortEmptyLabel(state)
    : effortEmptyLabel;

  return (
    <Stack direction={runtimeDirection} spacing={runtimeSpacing}>
      {showModel ? (
        <FormControl fullWidth disabled={disabled} size={size}>
          <InputLabel id={modelLabelId} shrink>{modelLabel}</InputLabel>
          <Select
            labelId={modelLabelId}
            label={modelLabel}
            value={modelValue}
            displayEmpty
            onChange={(event: SelectChangeEvent) => {
              const model = event.target.value;
              const resetEffort = resetEffortOnModelChange === "always"
                || !effortSelectionIsCompatible(engine, model, selection.effort);
              onChange({
                model,
                effort: resetEffort ? "" : selection.effort,
              });
            }}
          >
            <MenuItem value="">{resolvedModelEmptyLabel}</MenuItem>
            {state.models.map((option) => (
              <MenuItem
                key={option.id}
                value={option.id}
                disabled={option.disabled}
              >
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : null}
      {showEffort ? (
        <FormControl fullWidth disabled={disabled} size={size}>
          <InputLabel id={effortLabelId} shrink>{effortLabel}</InputLabel>
          <Select
            labelId={effortLabelId}
            label={effortLabel}
            value={effortValue}
            displayEmpty
            onChange={(event: SelectChangeEvent) => onChange({
              model: selection.model,
              effort: event.target.value,
            })}
          >
            <MenuItem value="">{resolvedEffortEmptyLabel}</MenuItem>
            {state.efforts.map((option) => (
              <MenuItem
                key={option.id}
                value={option.id}
                disabled={option.disabled}
              >
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : null}
    </Stack>
  );
}

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
  const optionSelection = {
    model: model || inherited.model,
    effort: effort || inherited.effort,
  };
  return (
    <EngineModelEffortFields
      engine={engine}
      selection={{ model, effort }}
      optionSelection={optionSelection}
      onChange={onChange}
      modelLabel={modelLabel}
      effortLabel={effortLabel}
      modelLabelId={modelLabelId}
      effortLabelId={effortLabelId}
      modelEmptyLabel={(state) => {
        const inheritedModelLabel = state.models.find(
          (option) => option.id === inherited.model,
        )?.label ?? inherited.model ?? inheritedFallback;
        return `${inheritedPrefix} — ${inheritedModelLabel || inheritedFallback}`;
      }}
      effortEmptyLabel={(state) => {
        const inheritedEffortLabel = state.efforts.find(
          (option) => option.id === inherited.effort,
        )?.label ?? inherited.effort ?? inheritedFallback;
        return `${inheritedPrefix} — ${inheritedEffortLabel || inheritedFallback}`;
      }}
      disabled={disabled}
      runtimeDirection={{ xs: "column", sm: "row" }}
      runtimeSpacing={1.5}
      guardSelection={false}
      resetEffortOnModelChange="always"
    />
  );
}
