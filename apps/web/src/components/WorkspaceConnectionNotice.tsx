import { Alert, Box, Button, Stack, Typography } from "@mui/material";
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
      action={<Stack direction="row"><Button size="small" color="inherit" onClick={() => { if (disconnected) connection.retry?.(); issues.forEach(issue => issue.retry()); }}>Retry</Button><Button size="small" color="inherit" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Details</Button></Stack>}>
      {disconnected ? hasSavedData ? "Connection interrupted. Previously loaded data remains visible; live updates may be missing." : "Connection interrupted. Workspace data is not available yet." : "Some previously loaded data could not refresh."}
      {expanded ? <Box sx={{ mt: .5 }}>
        {disconnected ? <Typography variant="caption" component="p">Live updates have not reconnected.{connection.lastSuccessfulSyncAt ? ` Last synced ${new Date(connection.lastSuccessfulSyncAt).toLocaleTimeString()}.` : " No successful sync has been recorded."} Retry checks the connection again.</Typography> : null}
        {issues.map((issue, index) => <Typography key={index} variant="caption" component="p">{issue.detail}</Typography>)}
      </Box> : null}
    </Alert> : null}
    <Box aria-live="polite" sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)" }}>{connection.announcement}</Box>
  </>;
}
