import { Alert, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

export function ResourceNotificationSettings({ kind, id }: { kind: "agent" | "conversation"; id: string }): JSX.Element {
  const client = useQueryClient();
  const preferences = useQuery({ queryKey: queryKeys.workspacePreferences.all, queryFn: () => api.getWorkspacePreferences() });
  const save = useMutation({
    mutationFn: (mode: "all" | "attention" | "muted" | "inherit") => api.setNotificationMode(kind, id, mode),
    onSuccess: async value => {
      client.setQueryData(queryKeys.workspacePreferences.all, value);
      await client.invalidateQueries({ predicate: query => String(query.queryKey[0]).includes("notification") });
    },
  });
  return <Stack spacing={1}>
    <TextField select fullWidth size="small" label="Notifications" disabled={!preferences.data || save.isPending}
      value={preferences.data?.notificationScopes?.[`${kind}:${id}`] ?? (kind === "agent" ? "inherit" : "all")}
      onChange={event => save.mutate(event.target.value as "all" | "attention" | "muted" | "inherit")}>
      {kind === "agent" && <MenuItem value="inherit">Use chat setting</MenuItem>}
      <MenuItem value="all">All</MenuItem>
      <MenuItem value="attention">Needs attention only</MenuItem>
      <MenuItem value="muted">Muted</MenuItem>
    </TextField>
    <Typography variant="caption" color="text.secondary">Saves immediately. Controls in-app notifications and browser push. Work, messages, and pending decisions are unchanged.</Typography>
    {kind === "conversation" && <Typography variant="caption" color="text.secondary">Agents inherit this setting unless they have their own override.</Typography>}
    {(save.isError || preferences.isError) && <Alert severity="error">Could not load or save notification settings. Try again.</Alert>}
  </Stack>;
}
