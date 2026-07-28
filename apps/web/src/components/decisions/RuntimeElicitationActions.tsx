import LaunchIcon from "@mui/icons-material/Launch";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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

function titleCase(value: string): string {
  return value
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function fieldsFor(action: RuntimeElicitationActionDto | undefined): FormField[] {
  if (!action || action.mode === "url") return [];
  const schema = action.requestedSchema;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []);
  return Object.entries(properties).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const property = raw as Record<string, unknown>;
    const type = property.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") return [];
    return [{
      name,
      label: typeof property.title === "string" && property.title.trim() ? property.title : titleCase(name),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      type,
      required: required.has(name),
      ...(Array.isArray(property.enum) && property.enum.every((item) => typeof item === "string")
        ? { options: property.enum as string[] }
        : {}),
    }];
  });
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
  const [formOpen, setFormOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const action = useQuery({
    queryKey: ["decision-action", decision.id],
    queryFn: () => api.getDecisionAction(decision.id),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const fields = useMemo(() => fieldsFor(action.data), [action.data]);
  const provider = titleCase(decision.runtimeAction?.serverName ?? "Provider");
  const submit = async (): Promise<void> => {
    const content: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name];
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
    setFormOpen(false);
  };

  if (action.isPending) return <Typography variant="body2" color="text.secondary">Preparing secure connection…</Typography>;
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
        </Stack>
        <Typography variant="caption" color="text.secondary">
          The secure connection opens in a new tab. Return here and confirm when it is complete.
        </Typography>
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Stack>
    );
  }

  return (
    <>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        <Button size="small" variant="contained" onClick={() => {
          setFieldErrors({});
          setFormOpen(true);
        }}>Provide Information</Button>
        <Button size="small" color="inherit" disabled={pending} onClick={() => void onRespond({ optionId: "decline" })}>Not Now</Button>
      </Stack>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Dialog open={formOpen} onClose={() => setFormOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{provider} Needs Information</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">{action.data.message}</Typography>
            {fields.length ? fields.map((field) => field.type === "boolean" ? (
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
            )) : <Alert severity="warning">This provider requested a form Ponderosa cannot safely display.</Alert>}
            <Typography variant="caption" color="text.secondary">
              Your answers go directly to the provider and are not saved in Ponderosa.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFormOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={pending || !fields.length} onClick={() => void submit()}>Submit</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
