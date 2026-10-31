import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import type { BrowserSession } from "./browserAdapters";

export function LocalBrowserSetup({ projectId, session, onConnected, onClose }: {
  projectId: string; session?: BrowserSession; onConnected(): void; onClose(): void;
}): JSX.Element {
  const connections = useQuery({ queryKey: ["local-browser", projectId], queryFn: () => api.listLocalBrowsers(projectId), refetchInterval: 2000 });
  const pair = useMutation({ mutationFn: () => api.pairLocalBrowser(projectId) });
  const connect = useMutation({ mutationFn: async (id: string) => {
    if (session && session.status !== "closed" && session.status !== "failed") {
      if (session.controlOwner !== "operator") throw new Error("Take control before switching browsers.");
      if (!window.confirm("End the current browser connection and use your local window? Unsaved hosted page input may be lost. Your local tabs will stay open.")) return false;
      await api.closeProjectBrowser(projectId);
    }
    await api.connectLocalBrowser(projectId, id); return true;
  }, onSuccess: connected => { if (connected) onConnected(); } });
  const error = pair.error ?? connect.error ?? connections.error;
  return <Box sx={{ p: 2, overflow: "auto" }}><Stack spacing={1.5}>
    <Typography variant="h6">Connect your browser</Typography>
    <Typography variant="body2">Use Chrome/Edge with Ponderosa extension 0.4.1.</Typography>
    <TextField size="small" label="Ponderosa address" value={window.location.origin} inputProps={{ readOnly: true }} />
    {pair.data ? <><TextField size="small" label="Pairing code — valid for 5 minutes" value={pair.data.code} inputProps={{ readOnly: true }} onFocus={event => event.target.select()} /><Typography variant="caption">Paste this code in the extension, then choose Connect this window.</Typography></> : null}
    <Button variant="outlined" disabled={pair.isPending} onClick={() => pair.mutate()}>{pair.data ? "Create a new code" : "Create pairing code"}</Button>
    {(connections.data ?? []).filter(item => item.connected && !item.claimed).map(item => <Button key={item.id} variant="contained" disabled={connect.isPending} onClick={() => connect.mutate(item.id)}>Use window: {item.title || "connected browser"}</Button>)}
    {error ? <Alert severity="error">{error instanceof Error ? error.message : "Connection failed"}</Alert> : null}
    <Button onClick={onClose}>Back to browser</Button>
  </Stack></Box>;
}
