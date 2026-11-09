import SyncProblemOutlinedIcon from "@mui/icons-material/SyncProblemOutlined";
import { Box, Button, CircularProgress, Popover, Stack, Typography } from "@mui/material";
import { useEffect, useId, useState } from "react";
import type { WorkspaceConnectionState } from "../hooks/useWorkspaceStream";
import { browserPageIsVisible, createForegroundTimer } from "../queryVisibility";
import { useWorkspaceRefreshIssues } from "./WorkspaceRefreshContext";

/** One compact projection of the existing stream/refresh authorities. */
export function WorkspaceConnectionNotice({ connection, hasSavedData = false }: { connection: WorkspaceConnectionState; hasSavedData?: boolean }): JSX.Element {
  const reportedIssues = useWorkspaceRefreshIssues();
  const [foreground, setForeground] = useState(browserPageIsVisible);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const [matureIssues, setMatureIssues] = useState(false);
  const issueKey = Object.entries(reportedIssues).map(([id, issue]) => `${id}:${issue.detail}`).sort().join("|");
  useEffect(() => {
    setMatureIssues(false);
    const timer = createForegroundTimer(() => setMatureIssues(true), 8_000);
    const visibility = () => { setForeground(browserPageIsVisible()); setMatureIssues(false); };
    document.addEventListener("visibilitychange", visibility);
    if (issueKey) timer.start();
    return () => { timer.dispose(); document.removeEventListener("visibilitychange", visibility); };
  }, [issueKey]);
  const issues = Object.values(reportedIssues);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const detailsId = useId();
  const disconnected = connection.status === "stale" || connection.status === "unavailable" || connection.prolongedDisconnect;
  const phaseIssues = connection.refreshErrorResources ?? [];
  const visible = foreground && (disconnected || phaseIssues.length > 0 || (matureIssues && issues.length > 0));
  const label = disconnected ? (!online ? "Offline" : "Reconnecting")
    : phaseIssues.length ? `${phaseIssues.join(" / ")} delayed` : "Refresh delayed";
  useEffect(() => { if (!visible) setAnchor(null); }, [visible]);
  return <>
    {visible ? <Button
      size="small" color="inherit" startIcon={<SyncProblemOutlinedIcon fontSize="small" />}
      aria-haspopup="dialog" aria-expanded={Boolean(anchor)} aria-controls={anchor ? detailsId : undefined}
      onClick={event => setAnchor(event.currentTarget)}
      sx={theme => ({ whiteSpace: "nowrap", minHeight: { xs: 44, sm: 32 }, px: 1, color: "text.secondary", [theme.breakpoints.down("sm")]: { px: 0.5, fontSize: "0.75rem", "& .MuiButton-startIcon": { mr: 0.5 } }, "@media (pointer: coarse)": { minHeight: 44 } })}
    >{label}</Button> : null}
    <Popover open={visible && Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
      <Box id={detailsId} role="dialog" aria-label="Workspace update details" sx={{ p: 2, width: 340, maxWidth: "calc(100vw - 24px)", overflowWrap: "anywhere" }}>
        <Typography variant="subtitle2">{label}</Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>{disconnected
          ? hasSavedData ? "Saved data remains visible. Messages and Agent statuses may be out of date." : "Workspace data has not loaded yet."
          : "Some previously loaded data could not refresh."}</Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>This does not mean an Agent stopped or that its work failed.</Typography>
        <Typography variant="caption" component="p" sx={{ mt: 1 }}>{connection.lastSuccessfulSyncAt
          ? `Last confirmed: ${new Date(connection.lastSuccessfulSyncAt).toLocaleString()}.`
          : "No successful sync has been confirmed in this browser yet."}</Typography>
        {disconnected ? <Typography variant="caption" component="p">{connection.retrying
          ? "Checking the connection and refreshing saved state. Live updates are not confirmed yet."
          : "Ponderosa retries automatically. Retry starts a new check now. The cause has not been confirmed."}</Typography> : null}
        {phaseIssues.map(resource => <Typography key={resource} variant="caption" component="p">{resource} could not refresh. Last known status remains visible.</Typography>)}
        {issues.map((issue, index) => <Typography key={index} variant="caption" component="p">{issue.detail}</Typography>)}
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1 }}>
          <Button size="small" onClick={() => setAnchor(null)}>Close</Button>
          <Button size="small" disabled={connection.retrying} startIcon={connection.retrying ? <CircularProgress size={14} /> : undefined}
            onClick={() => { if (disconnected || phaseIssues.length) connection.retry?.(); issues.forEach(issue => issue.retry()); }}>
            {connection.retrying ? "Checking…" : "Retry"}
          </Button>
        </Stack>
      </Box>
    </Popover>
  </>;
}
