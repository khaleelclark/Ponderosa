import CloseIcon from "@mui/icons-material/Close";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import LanguageIcon from "@mui/icons-material/Language";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert, Box, Button, Chip, CircularProgress, IconButton, Paper, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { BrowserSessionDto } from "@ponderosa/core";
import { useMemo, useState } from "react";
import { BrowserViewport } from "./browser/BrowserViewport";
import { runBrowserAdapter } from "./browser/browserAdapters";
import { useBrowserController } from "./browser/useBrowserController";
import { FeatureErrorBoundary } from "./FeatureErrorBoundary";

export function browserControlLabel(session: BrowserSessionDto): string {
  return session.controlOwner === "operator" ? "You have control" : "Agent has control";
}

export function BrowserPanel({
  projectId,
  agentId,
  runId,
  standalone = false,
  onOpenInTab,
}: {
  projectId: string;
  agentId: string;
  runId?: string;
  standalone?: boolean;
  onOpenInTab?(): void;
}): JSX.Element | null {
  const adapter = useMemo(
    () => runBrowserAdapter(projectId, agentId, runId ?? ""),
    [agentId, projectId, runId],
  );
  const browser = useBrowserController({ adapter, enabled: Boolean(runId) });
  const [expanded, setExpanded] = useState(standalone);
  const [typeText, setTypeText] = useState("");
  const session = browser.session;

  if (!runId) {
    return standalone
      ? <Alert severity="info" sx={{ m: 2 }}>This Run’s interactive browser is no longer active.</Alert>
      : null;
  }
  if (browser.missing) {
    return standalone
      ? <Alert severity="info" sx={{ m: 2 }}>This Run’s interactive browser is no longer active.</Alert>
      : null;
  }
  if (browser.query.isPending) {
    return standalone
      ? <Stack role="status" aria-live="polite" direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "center", height: "100%", minHeight: 120, p: 2 }}><CircularProgress size={20} /><Typography variant="body2">Loading interactive browser…</Typography></Stack>
      : <Paper component="section" role="status" aria-live="polite" aria-label="Loading interactive browser" square variant="outlined" sx={{ borderInline: 0, borderTop: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: { xs: 1, sm: 1.5 }, py: .75 }}><CircularProgress size={18} /><Typography variant="body2">Connecting to interactive browser…</Typography></Stack>
      </Paper>;
  }
  if (!session || session.status === "closed") {
    return standalone
      ? <Alert severity="info" sx={{ m: 2 }}>This Run’s interactive browser is no longer active.</Alert>
      : null;
  }

  const ready = session.status === "ready";
  const operatorControl = ready && session.controlOwner === "operator";
  if (!standalone) return <Paper component="section" aria-label="Interactive browser in use" square variant="outlined" sx={{ borderInline: 0, borderTop: 0 }}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: { xs: 1, sm: 1.5 }, py: .75, minWidth: 0 }}>
      <LanguageIcon color={ready ? "primary" : "disabled"} fontSize="small" />
      <Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="subtitle2" noWrap>Interactive browser in use</Typography><Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>{session.url ?? session.status}</Typography></Box>
      <Chip size="small" color={operatorControl ? "warning" : ready ? "info" : "default"} variant="outlined" label={ready ? browserControlLabel(session) : session.status} />
      <Button size="small" variant="outlined" onClick={onOpenInTab}>Open Tab</Button>
    </Stack>
  </Paper>;

  const submitText = () => {
    if (!typeText) return;
    browser.sendInput({ kind: "type", text: typeText });
    setTypeText("");
  };

  return <FeatureErrorBoundary feature="Interactive browser">
    <Paper component="section" aria-label="Interactive browser" className="ponderosa-scroll" square variant="outlined" sx={{ height: "100%", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", borderInline: 0, borderTop: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: { xs: 1, sm: 1.5 }, py: .75, minWidth: 0 }}>
        <LanguageIcon color={ready ? "primary" : "disabled"} fontSize="small" />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle2" noWrap>Interactive browser</Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>{session.url ?? session.failure ?? "Host-managed, run-scoped session"}</Typography>
        </Box>
        <Chip size="small" color={operatorControl ? "warning" : ready ? "info" : "default"} variant="outlined" label={ready ? browserControlLabel(session) : session.status} />
        <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? "Collapse" : "Open"}</Button>
        <Tooltip title="Reconnect the browser process to this Run"><span><IconButton size="small" aria-label="Reconnect browser" disabled={browser.reconnect.isPending} onClick={() => browser.reconnect.mutate()}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip>
        <Tooltip title="Close Browser Session"><span><IconButton size="small" aria-label="Close browser" disabled={browser.close.isPending} onClick={() => browser.close.mutate(undefined, { onSuccess: () => setExpanded(false) })}><CloseIcon fontSize="small" /></IconButton></span></Tooltip>
      </Stack>
      {expanded ? <Box sx={{ px: { xs: 1, sm: 1.5 }, pb: 1.25 }}>
        {ready ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1, alignItems: { sm: "center" } }}>
          <Button
            size="small"
            variant={operatorControl ? "contained" : "outlined"}
            color={operatorControl ? "warning" : "primary"}
            disabled={browser.control.isPending}
            onClick={() => browser.control.mutate({ owner: operatorControl ? "agent" : "operator" })}
          >
            {operatorControl ? "Return Control to Agent" : "Take Control"}
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            Input is fenced to one owner and this session’s current control epoch.
          </Typography>
          <Tooltip title="Collapse Browser"><IconButton size="small" aria-label="Collapse browser" onClick={() => setExpanded(false)}><ExpandLessIcon /></IconButton></Tooltip>
        </Stack> : null}
        <BrowserViewport
          adapter={adapter}
          session={session}
          active={expanded}
          operatorControl={operatorControl}
          sendInput={browser.sendInput}
          refreshFrame={browser.refreshFrame}
        />
        {ready ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
          <TextField
            size="small"
            fullWidth
            label="Type into focused page control"
            value={typeText}
            disabled={!operatorControl}
            onChange={(event) => setTypeText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitText(); } }}
          />
          <Button variant="outlined" disabled={!operatorControl || !typeText || browser.input.isPending} onClick={submitText}>Type</Button>
        </Stack> : null}
        {browser.error ? <Alert severity="error" sx={{ mt: 1 }}>{browser.error instanceof Error ? browser.error.message : String(browser.error)}</Alert> : null}
      </Box> : null}
    </Paper>
  </FeatureErrorBoundary>;
}
