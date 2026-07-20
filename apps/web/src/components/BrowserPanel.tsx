import CloseIcon from "@mui/icons-material/Close";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import LanguageIcon from "@mui/icons-material/Language";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { BrowserOperatorInputRequest, BrowserSessionDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
type UnfencedBrowserInput = BrowserOperatorInputRequest extends infer Input
  ? Input extends BrowserOperatorInputRequest ? Omit<Input, "expectedControlEpoch"> : never
  : never;

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
  const queryClient = useQueryClient();
  const queryKey = ["browser-session", projectId, agentId, runId] as const;
  const [expanded, setExpanded] = useState(standalone);
  const [frameUrl, setFrameUrl] = useState<string>();
  const [frameError, setFrameError] = useState<string>();
  const [typeText, setTypeText] = useState("");
  const wheelAt = useRef(0);

  const sessionQuery = useQuery({
    queryKey,
    queryFn: () => api.getBrowserSession(projectId, agentId, runId!),
    enabled: Boolean(runId),
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "opening" ? 750 : 2_500,
  });
  const session = sessionQuery.data;
  const missing = sessionQuery.error instanceof ApiRequestError && sessionQuery.error.status === 404;

  const update = (next: BrowserSessionDto): void => {
    queryClient.setQueryData(queryKey, next);
  };
  const reconnect = useMutation({
    mutationFn: () => api.reconnectBrowserSession(projectId, agentId, runId!),
    onSuccess: update,
  });
  const close = useMutation({
    mutationFn: () => api.closeBrowserSession(projectId, agentId, runId!),
    onSuccess: (next) => { update(next); setExpanded(false); },
  });
  const control = useMutation({
    mutationFn: (owner: "agent" | "operator") => api.setBrowserControl(projectId, agentId, runId!, {
      owner,
      expectedControlEpoch: session!.controlEpoch,
    }),
    onSuccess: update,
  });
  const input = useMutation({
    mutationFn: (request: UnfencedBrowserInput) => api.sendBrowserInput(
      projectId,
      agentId,
      runId!,
      { ...request, expectedControlEpoch: session!.controlEpoch } as BrowserOperatorInputRequest,
    ),
    onSuccess: update,
  });

  useEffect(() => {
    if (!expanded || session?.status !== "ready" || !runId) {
      setFrameUrl((current) => { if (current) URL.revokeObjectURL(current); return undefined; });
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      try {
        const frame = await api.getBrowserFrame(projectId, agentId, runId);
        if (cancelled) return;
        const next = URL.createObjectURL(frame.blob);
        const preload = new Image();
        preload.onload = () => {
          if (cancelled) { URL.revokeObjectURL(next); return; }
          setFrameUrl((current) => { if (current) URL.revokeObjectURL(current); return next; });
          setFrameError(undefined);
        };
        preload.onerror = () => { URL.revokeObjectURL(next); if (!cancelled) setFrameError("Browser frame could not be decoded."); };
        preload.src = next;
      } catch (error) {
        if (!cancelled) setFrameError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void load(), 700);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      setFrameUrl((current) => { if (current) URL.revokeObjectURL(current); return undefined; });
    };
  }, [agentId, expanded, projectId, runId, session?.id, session?.status]);

  if (!runId || !session || missing || session.status === "closed") {
    return standalone
      ? <Alert severity="info" sx={{ m: 2 }}>This Run’s interactive browser is no longer active.</Alert>
      : null;
  }
  const mutationError = reconnect.error ?? close.error ?? control.error ?? input.error;
  const ready = session?.status === "ready";
  const operatorControl = ready && session.controlOwner === "operator";

  const sendInput = (request: UnfencedBrowserInput): void => {
    if (operatorControl && !input.isPending) input.mutate(request);
  };

  if (!standalone) return <Paper component="section" aria-label="Interactive browser in use" square variant="outlined" sx={{ borderInline: 0, borderTop: 0 }}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: { xs: 1, sm: 1.5 }, py: .75, minWidth: 0 }}>
      <LanguageIcon color={ready ? "primary" : "disabled"} fontSize="small" />
      <Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="subtitle2" noWrap>Interactive browser in use</Typography><Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>{session.url ?? session.status}</Typography></Box>
      <Chip size="small" color={operatorControl ? "warning" : ready ? "info" : "default"} variant="outlined" label={ready ? browserControlLabel(session) : session.status} />
      <Button size="small" variant="outlined" onClick={onOpenInTab}>Open Tab</Button>
    </Stack>
  </Paper>;

  return (
    <Paper component="section" aria-label="Interactive browser" square variant="outlined" sx={{ borderInline: 0, borderTop: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: { xs: 1, sm: 1.5 }, py: .75, minWidth: 0 }}>
        <LanguageIcon color={ready ? "primary" : "disabled"} fontSize="small" />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle2" noWrap>Interactive browser</Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
            {session?.url ?? (missing ? "No session for this run" : session?.failure ?? "Host-managed, run-scoped session")}
          </Typography>
        </Box>
        {session ? <Chip
          size="small"
          color={operatorControl ? "warning" : ready ? "info" : "default"}
          variant="outlined"
          label={ready ? browserControlLabel(session) : session.status}
        /> : null}
        <>
            <Button size="small" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
              {expanded ? "Collapse" : "Open"}
            </Button>
            <Tooltip title="Reconnect the browser process to this run">
              <span><IconButton size="small" aria-label="Reconnect browser" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}><RefreshIcon fontSize="small" /></IconButton></span>
            </Tooltip>
            <Tooltip title="Close Browser Session">
              <span><IconButton size="small" aria-label="Close browser" disabled={close.isPending} onClick={() => close.mutate()}><CloseIcon fontSize="small" /></IconButton></span>
            </Tooltip>
        </>
      </Stack>

      {expanded && session ? (
        <Box sx={{ px: { xs: 1, sm: 1.5 }, pb: 1.25 }}>
          {session.status === "opening" ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", p: 2 }}><CircularProgress size={18} /><Typography variant="body2">Starting the host browser…</Typography></Stack> : null}
          {session.status === "failed" ? <Alert severity="error">{session.failure ?? "The host browser failed to start."}</Alert> : null}
          {ready ? (
            <>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mb: 1, alignItems: { sm: "center" } }}>
                <Button
                  size="small"
                  variant={operatorControl ? "contained" : "outlined"}
                  color={operatorControl ? "warning" : "primary"}
                  disabled={control.isPending}
                  onClick={() => control.mutate(operatorControl ? "agent" : "operator")}
                >
                  {operatorControl ? "Return Control to Agent" : "Take Control"}
                </Button>
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  Input is fenced to one owner. Other tabs must refresh after control changes.
                </Typography>
                <Tooltip title="Collapse Browser"><IconButton size="small" aria-label="Collapse browser" onClick={() => setExpanded(false)}><ExpandLessIcon /></IconButton></Tooltip>
              </Stack>
              <Box
                sx={{ position: "relative", width: "100%", aspectRatio: `${VIEWPORT_WIDTH} / ${VIEWPORT_HEIGHT}`, bgcolor: "grey.950", borderRadius: 1, overflow: "hidden", border: 1, borderColor: operatorControl ? "warning.main" : "divider" }}
              >
                {frameUrl ? <Box
                  component="img"
                  src={frameUrl}
                  alt={`Live browser viewport: ${session.title ?? session.url ?? "page"}`}
                  tabIndex={operatorControl ? 0 : -1}
                  onClick={(event) => {
                    if (!operatorControl) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    sendInput({ kind: "click", x: (event.clientX - rect.left) * VIEWPORT_WIDTH / rect.width, y: (event.clientY - rect.top) * VIEWPORT_HEIGHT / rect.height });
                  }}
                  onKeyDown={(event) => {
                    if (!operatorControl || event.key === "Tab" || event.key === "Escape") return;
                    event.preventDefault();
                    sendInput({ kind: "key", key: event.key });
                  }}
                  onWheel={(event) => {
                    if (!operatorControl || Date.now() - wheelAt.current < 120) return;
                    wheelAt.current = Date.now();
                    sendInput({ kind: "scroll", deltaX: event.deltaX, deltaY: event.deltaY });
                  }}
                  sx={{ width: "100%", height: "100%", objectFit: "contain", display: "block", cursor: operatorControl ? "crosshair" : "default", outlineOffset: -3 }}
                /> : <Stack sx={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}><CircularProgress size={24} /></Stack>}
              </Box>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1 }}>
                <TextField
                  size="small"
                  fullWidth
                  label="Type into focused page control"
                  value={typeText}
                  disabled={!operatorControl}
                  onChange={(event) => setTypeText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && typeText) {
                      event.preventDefault();
                      sendInput({ kind: "type", text: typeText });
                      setTypeText("");
                    }
                  }}
                />
                <Button variant="outlined" disabled={!operatorControl || !typeText || input.isPending} onClick={() => {
                  sendInput({ kind: "type", text: typeText });
                  setTypeText("");
                }}>Type</Button>
              </Stack>
            </>
          ) : null}
          {frameError ? <Alert severity="warning" sx={{ mt: 1 }}>Live frame disconnected: {frameError}</Alert> : null}
          {mutationError ? <Alert severity="error" sx={{ mt: 1 }}>{String(mutationError)}</Alert> : null}
        </Box>
      ) : null}
    </Paper>
  );
}
