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
import { browserTouchScrollDelta, mergeBrowserScrollInputs, normalizeBrowserWheelDelta, type BrowserScrollInput } from "../browserInteraction";

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
  const inputBusy = useRef(false);
  const queuedScroll = useRef<BrowserScrollInput>();
  const touchGesture = useRef<{ pointerId: number; lastX: number; lastY: number }>();
  const suppressClick = useRef(false);
  const refreshFrame = useRef<() => void>(() => undefined);

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
    onSuccess: (next) => {
      update(next);
      refreshFrame.current();
    },
  });

  useEffect(() => {
    if (!expanded || session?.status !== "ready" || !runId) {
      setFrameUrl((current) => { if (current) URL.revokeObjectURL(current); return undefined; });
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    let loading = false;
    let refreshRequested = false;
    const load = async (): Promise<void> => {
      if (loading) { refreshRequested = true; return; }
      loading = true;
      refreshRequested = false;
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
        loading = false;
        if (!cancelled) {
          const delay = refreshRequested ? 0 : 1_500;
          refreshRequested = false;
          timer = window.setTimeout(() => void load(), delay);
        }
      }
    };
    refreshFrame.current = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      refreshRequested = true;
      void load();
    };
    void load();
    return () => {
      cancelled = true;
      refreshFrame.current = () => undefined;
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
    if (!operatorControl) return;
    if (inputBusy.current) {
      if (request.kind === "scroll") queuedScroll.current = mergeBrowserScrollInputs(queuedScroll.current, request);
      return;
    }
    inputBusy.current = true;
    input.mutate(request, {
      onSettled: (_data, error) => {
        inputBusy.current = false;
        const next = queuedScroll.current;
        queuedScroll.current = undefined;
        if (!error && next) sendInput(next);
      },
    });
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
    <Paper component="section" aria-label="Interactive browser" className="ponderosa-scroll" square variant="outlined" sx={{ height: "100%", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", borderInline: 0, borderTop: 0 }}>
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
                    if (suppressClick.current) { suppressClick.current = false; return; }
                    const rect = event.currentTarget.getBoundingClientRect();
                    sendInput({ kind: "click", x: (event.clientX - rect.left) * VIEWPORT_WIDTH / rect.width, y: (event.clientY - rect.top) * VIEWPORT_HEIGHT / rect.height });
                  }}
                  onKeyDown={(event) => {
                    if (!operatorControl || event.key === "Tab" || event.key === "Escape") return;
                    event.preventDefault();
                    sendInput({ kind: "key", key: event.key });
                  }}
                  onWheel={(event) => {
                    if (!operatorControl) return;
                    event.preventDefault();
                    sendInput({
                      kind: "scroll",
                      deltaX: normalizeBrowserWheelDelta(event.deltaX, event.deltaMode, event.currentTarget.clientWidth),
                      deltaY: normalizeBrowserWheelDelta(event.deltaY, event.deltaMode, event.currentTarget.clientHeight),
                    });
                  }}
                  onPointerDown={(event) => {
                    if (!operatorControl || event.pointerType !== "touch") return;
                    touchGesture.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const gesture = touchGesture.current;
                    if (!operatorControl || !gesture || gesture.pointerId !== event.pointerId) return;
                    const deltaX = browserTouchScrollDelta(gesture.lastX, event.clientX);
                    const deltaY = browserTouchScrollDelta(gesture.lastY, event.clientY);
                    gesture.lastX = event.clientX;
                    gesture.lastY = event.clientY;
                    if (Math.abs(deltaX) + Math.abs(deltaY) < 2) return;
                    suppressClick.current = true;
                    event.preventDefault();
                    sendInput({ kind: "scroll", deltaX, deltaY });
                  }}
                  onPointerUp={(event) => {
                    if (touchGesture.current?.pointerId === event.pointerId) touchGesture.current = undefined;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                    if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 0);
                  }}
                  onPointerCancel={() => { touchGesture.current = undefined; }}
                  draggable={false}
                  sx={{ width: "100%", height: "100%", objectFit: "contain", display: "block", touchAction: operatorControl ? "none" : "auto", cursor: operatorControl ? "crosshair" : "default", outlineOffset: -3 }}
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
