import LaunchIcon from "@mui/icons-material/Launch";
import {
  Alert,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { RuntimeElicitationActionDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../api";
import type { DecisionPrompt, DecisionResponse } from "../../decisions";

interface FormField {
  name: string;
  label: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  options?: string[];
}

interface FormDescription {
  fields: FormField[];
  supported: boolean;
}

function titleCase(value: string): string {
  return value
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function describeForm(action: RuntimeElicitationActionDto | undefined): FormDescription {
  if (!action || action.mode === "url") return { fields: [], supported: true };
  const schema = action.requestedSchema;
  if (schema.type !== undefined && schema.type !== "object") return { fields: [], supported: false };
  if (schema.properties !== undefined &&
      (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
    return { fields: [], supported: false };
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []);
  let supported = schema.required === undefined ||
    (Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string"));
  const fields = Object.entries(properties).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      supported = false;
      return [];
    }
    const property = raw as Record<string, unknown>;
    const type = property.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
      supported = false;
      return [];
    }
    const options = Array.isArray(property.enum) && property.enum.every((item) => typeof item === "string")
      ? property.enum as string[]
      : undefined;
    if (property.enum !== undefined && (type !== "string" || !options)) supported = false;
    return [{
      name,
      label: typeof property.title === "string" && property.title.trim() ? property.title : titleCase(name),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      type,
      required: required.has(name),
      ...(options ? { options } : {}),
    }];
  });
  if ([...required].some((name) => !Object.hasOwn(properties, name))) supported = false;
  return { fields, supported };
}

export function RuntimeElicitationActions({
  decision,
  pending,
  error,
  onRespond,
}: {
  decision: DecisionPrompt;
  pending: boolean;
  error?: string;
  onRespond(response: DecisionResponse): Promise<unknown>;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const action = useQuery({
    queryKey: ["decision-action", decision.id],
    queryFn: () => api.getDecisionAction(decision.id),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const form = useMemo(() => describeForm(action.data), [action.data]);
  const fields = form.fields;
  const provider = titleCase(decision.runtimeAction?.serverName ?? "Provider");
  const submit = async (): Promise<void> => {
    const content: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (field.type === "boolean") {
        if (field.required || value !== undefined) content[field.name] = value === true;
        continue;
      }
      if (field.required && (value === undefined || value === "")) {
        nextErrors[field.name] = `${field.label} is required.`;
        continue;
      }
      if (value === undefined || value === "") continue;
      if (field.type === "number" || field.type === "integer") {
        const number = Number(value);
        if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
          nextErrors[field.name] = `Enter a valid ${field.type}.`;
          continue;
        }
        content[field.name] = number;
      } else {
        content[field.name] = value;
      }
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    await onRespond({ optionId: "submit", content });
  };
  const submitOther = async (): Promise<void> => {
    const text = otherText.trim();
    if (!text) return;
    await onRespond({ text });
  };
  const otherResponse = otherOpen ? (
    <Stack spacing={0.75}>
      <TextField
        autoFocus
        fullWidth
        multiline
        minRows={2}
        label="Tell the Agent what you want instead"
        value={otherText}
        onChange={(event) => setOtherText(event.target.value)}
      />
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        <Button size="small" variant="contained" disabled={pending || !otherText.trim()} onClick={() => void submitOther()}>Send to Agent</Button>
        <Button size="small" color="inherit" disabled={pending} onClick={() => { setOtherOpen(false); setOtherText(""); }}>Cancel</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        This declines the provider request and sends your response to the Agent.
      </Typography>
    </Stack>
  ) : null;

  if (action.isPending) return <Typography variant="body2" color="text.secondary">Preparing request…</Typography>;
  if (action.isError || !action.data) {
    return <Alert severity="warning">{action.error instanceof Error ? action.error.message : "This connection request is no longer available."}</Alert>;
  }

  if (action.data.mode === "url") {
    return (
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
          <Button
            component="a"
            href={action.data.url}
            target="_blank"
            rel="noreferrer"
            variant="contained"
            size="small"
            endIcon={<LaunchIcon />}
          >
            Connect {provider}
          </Button>
          <Button size="small" variant="outlined" disabled={pending} onClick={() => void onRespond({ optionId: "accept" })}>
            I&apos;ve Connected
          </Button>
          <Button size="small" color="inherit" disabled={pending} onClick={() => void onRespond({ optionId: "decline" })}>
            Not Now
          </Button>
          <Button size="small" color="inherit" disabled={pending} onClick={() => setOtherOpen(true)}>Other</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          The secure connection opens in a new tab. Return here and confirm when it is complete.
        </Typography>
        {otherResponse}
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Stack>
    );
  }

  return (
    <Stack spacing={1.25}>
      <Typography variant="body2">{action.data.message}</Typography>
      {fields.map((field) => field.type === "boolean" ? (
        <Stack key={field.name} spacing={0}>
          <FormControlLabel
            control={<Checkbox checked={values[field.name] === true} onChange={(event) => {
              setValues((current) => ({ ...current, [field.name]: event.target.checked }));
              setFieldErrors((current) => {
                const { [field.name]: _removed, ...rest } = current;
                return rest;
              });
            }} />}
            label={`${field.label}${field.required ? " *" : ""}`}
          />
          {fieldErrors[field.name] ? <Typography variant="caption" color="error">{fieldErrors[field.name]}</Typography> : null}
        </Stack>
      ) : (
        <TextField
          key={field.name}
          fullWidth
          size="small"
          label={field.label}
          required={field.required}
          type={field.type === "number" || field.type === "integer" ? "number" : "text"}
          value={String(values[field.name] ?? "")}
          error={Boolean(fieldErrors[field.name])}
          helperText={fieldErrors[field.name] ?? field.description}
          select={Boolean(field.options?.length)}
          onChange={(event) => {
            setValues((current) => ({ ...current, [field.name]: event.target.value }));
            setFieldErrors((current) => {
              const { [field.name]: _removed, ...rest } = current;
              return rest;
            });
          }}
        >
          {field.options?.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
        </TextField>
      ))}
      {!form.supported ? <Alert severity="warning">Some requested fields cannot be displayed safely. Choose Other to tell the Agent how to proceed.</Alert> : null}
      {fields.length ? <Typography variant="caption" color="text.secondary">
        Your answers go directly to the provider and are not saved in Ponderosa.
      </Typography> : null}
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        <Button size="small" variant="contained" disabled={pending || !form.supported} onClick={() => void submit()}>{fields.length ? "Submit" : "Allow"}</Button>
        <Button size="small" color="inherit" disabled={pending} onClick={() => void onRespond({ optionId: "decline" })}>Not Now</Button>
        <Button size="small" color="inherit" disabled={pending} onClick={() => setOtherOpen(true)}>Other</Button>
      </Stack>
      {otherResponse}
      {error ? <Alert severity="error">{error}</Alert> : null}
    </Stack>
  );
}
