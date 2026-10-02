import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { useState } from "react";
import type { WorkspaceConnectionState } from "../hooks/useWorkspaceStream";
import { useWorkspaceRefreshIssues } from "./WorkspaceRefreshContext";

export function WorkspaceConnectionNotice({ connection, hasSavedData = false }: { connection: WorkspaceConnectionState; hasSavedData?: boolean }): JSX.Element {
  const issues = Object.values(useWorkspaceRefreshIssues());
  const [expanded, setExpanded] = useState(false);
  const disconnected = connection.status === "stale" || connection.status === "unavailable" || connection.prolongedDisconnect;
  const visible = disconnected || issues.length > 0;
  return <>
    {visible ? <Alert severity="warning" variant="outlined" sx={{ borderRadius: 0, borderInline: 0, py: 0, flexWrap: { xs: "wrap", sm: "nowrap" }, "& .MuiAlert-message": { py: .5, minWidth: 0, flex: 1, overflowWrap: "anywhere" }, "& .MuiAlert-action": { alignItems: "flex-start", justifyContent: "flex-end", width: { xs: "100%", sm: "auto" }, ml: { xs: 0, sm: 2 }, mr: 0, p: 0 } }}
      action={<Stack direction="row"><Button size="small" color="inherit" disabled={connection.retrying} startIcon={connection.retrying ? <CircularProgress size={14} color="inherit" /> : undefined} onClick={() => { if (disconnected) connection.retry?.(); issues.forEach(issue => issue.retry()); }}>{connection.retrying ? "Checking…" : "Retry"}</Button><Button size="small" color="inherit" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Hide details" : "Details"}</Button></Stack>}>
      {connection.retrying ? "Checking connection… Live updates are not confirmed yet." : disconnected ? hasSavedData ? "Live updates are disconnected. Saved data remains visible, but messages and Agent statuses may be out of date." : "Live updates are disconnected. Workspace data has not loaded yet." : "Some previously loaded data could not refresh."}
      {expanded ? <Box sx={{ mt: .5 }}>
        {disconnected ? <>
          <Typography variant="caption" component="p">This browser has lost its live connection to Ponderosa. This does not mean an Agent stopped or that its work failed.</Typography>
          <Typography variant="caption" component="p">{connection.lastSuccessfulSyncAt ? `Last live sync: ${new Date(connection.lastSuccessfulSyncAt).toLocaleString()}.` : "No live connection has been confirmed in this browser yet."}{connection.retryStartedAt ? ` Last manual check: ${new Date(connection.retryStartedAt).toLocaleTimeString()}.` : ""}</Typography>
          <Typography variant="caption" component="p">{connection.retrying ? "A new connection attempt is in progress." : "Ponderosa retries automatically. Retry starts a new attempt now. If this continues, check your network and whether the Ponderosa host is reachable. The exact cause has not been confirmed."}</Typography>
        </> : null}
        {issues.map((issue, index) => <Typography key={index} variant="caption" component="p">{issue.detail}</Typography>)}
      </Box> : null}
    </Alert> : null}
    <Box aria-live="polite" sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)" }}>{connection.announcement}</Box>
  </>;
}
