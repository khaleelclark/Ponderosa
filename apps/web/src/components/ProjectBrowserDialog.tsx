import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle,
  IconButton, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { BrowserOperatorInputRequest, ProjectBrowserSessionDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ApiRequestError } from "../api/types";
import type { ProjectBrowserRequest } from "./ProjectBrowserContext";

const VIEWPORT = { width: 1280, height: 720 } as const;
type Input = BrowserOperatorInputRequest extends infer Item
  ? Item extends BrowserOperatorInputRequest ? Omit<Item, "expectedControlEpoch"> : never
  : never;

export function ProjectBrowserDialog({
  projectId, open, request, onClose, embedded = false,
}: {
  projectId?: string;
  open: boolean;
  request?: ProjectBrowserRequest;
  onClose(): void;
  embedded?: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = ["project-browser", projectId] as const;
  const [address, setAddress] = useState("");
  const [frameUrl, setFrameUrl] = useState<string>();
  const [frameError, setFrameError] = useState<string>();
  const [typeText, setTypeText] = useState("");
  const wheelAt = useRef(0);
  const handledRequest = useRef(0);

  const sessionQuery = useQuery({
    queryKey,
    queryFn: () => api.getProjectBrowser(projectId!),
    enabled: Boolean(projectId && open),
    retry: false,
    refetchInterval: (query) => query.state.data?.status === "opening" ? 750 : 2_500,
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", projectId], queryFn: () => api.listAgents(projectId!), enabled: Boolean(projectId && open),
    refetchOnMount: "always", refetchInterval: 4_000,
  });
  const healthQuery = useQuery({
    queryKey: ["agent-health", projectId], queryFn: () => api.getAgentHealth(projectId!), enabled: Boolean(projectId && open), refetchInterval: 4_000,
  });
  const session = sessionQuery.data;
  const missing = sessionQuery.error instanceof ApiRequestError && sessionQuery.error.status === 404;
  const runningIds = new Set((healthQuery.data?.agents ?? []).filter((agent) => agent.status === "running").map((agent) => agent.agentId));
  const runningAgents = (agentsQuery.data ?? []).filter((agent) => runningIds.has(agent.id));
  const controllerName = (agentsQuery.data ?? []).find((agent) => agent.id === session?.controllerAgentId)?.title;
  const update = (next: ProjectBrowserSessionDto) => {
    queryClient.setQueryData(queryKey, next);
    if (next.url && next.url !== "about:blank") setAddress(next.url);
  };

  const openBrowser = useMutation({
    mutationFn: (url?: string) => api.openProjectBrowser(projectId!, url),
    onSuccess: update,
  });
  const navigate = useMutation({ mutationFn: (url: string) => api.navigateProjectBrowser(projectId!, url), onSuccess: update });
  const reconnect = useMutation({ mutationFn: () => api.reconnectProjectBrowser(projectId!), onSuccess: update });
  const close = useMutation({ mutationFn: () => api.closeProjectBrowser(projectId!), onSuccess: update });
  const control = useMutation({
    mutationFn: ({ owner, agentId }: { owner: "operator" | "agent"; agentId?: string }) => api.setProjectBrowserControl(projectId!, {
      owner, expectedControlEpoch: session!.controlEpoch, ...(agentId ? { agentId } : {}),
    }),
    onSuccess: update,
    onError: () => { void queryClient.invalidateQueries({ queryKey }); },
  });
  const input = useMutation({
    mutationFn: (value: Input) => api.sendProjectBrowserInput(projectId!, { ...value, expectedControlEpoch: session!.controlEpoch } as BrowserOperatorInputRequest),
    onSuccess: update,
  });

  useEffect(() => {
    if (!open || !projectId || !request || request.requestId === handledRequest.current) return;
    handledRequest.current = request.requestId;
    if (request.url) setAddress(request.url);
    openBrowser.mutate(request.url);
  }, [open, projectId, request?.requestId]);

  useEffect(() => {
    if (session?.url && session.url !== "about:blank") setAddress(session.url);
  }, [session?.url]);

  useEffect(() => {
    if (!open || session?.status !== "ready" || !projectId) {
      setFrameUrl((current) => { if (current) URL.revokeObjectURL(current); return undefined; });
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const frame = await api.getProjectBrowserFrame(projectId);
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
  }, [open, projectId, session?.id, session?.status]);

  const operator = session?.status === "ready" && session.controlOwner === "operator";
  const sendInput = (value: Input) => { if (operator && !input.isPending) input.mutate(value); };
  const error = openBrowser.error ?? navigate.error ?? reconnect.error ?? close.error ?? control.error ?? input.error;
  const submitAddress = () => {
    const url = address.trim();
    if (!url || !projectId) return;
    if (!session || missing || session.status === "closed") openBrowser.mutate(url);
    else navigate.mutate(url);
  };

  useEffect(() => {
    if (open) return;
    openBrowser.reset(); navigate.reset(); reconnect.reset(); close.reset(); control.reset(); input.reset();
  }, [open]);

  const content = <>
    <DialogTitle id="project-browser-title">
      <Stack spacing={.25}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          <Typography variant="h6" noWrap sx={{ flex: 1, minWidth: 0 }}>Project browser</Typography>
          {session ? <Chip size="small" variant="outlined" color={operator ? "success" : "warning"} label={operator ? "You have control" : `${controllerName ?? "Agent"} has control`} /> : null}
          {!embedded ? <Tooltip title="Close panel"><IconButton aria-label="Close Project browser" onClick={onClose}><CloseIcon /></IconButton></Tooltip> : null}
        </Stack>
        <Typography variant="caption" color="text.secondary">Persistent across agent Runs until closed or the server restarts</Typography>
      </Stack>
    </DialogTitle>
    <DialogContent dividers sx={{ p: { xs: 1, sm: 2 }, display: "grid", gridTemplateRows: { xs: "auto auto auto", sm: "auto minmax(0, 1fr) auto" }, alignContent: { xs: "start", sm: "stretch" }, gap: 1, minHeight: 0 }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr) auto auto", sm: "minmax(0, 1fr) auto auto auto" }, gap: 1 }}>
        <TextField size="small" fullWidth label="Address" value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitAddress(); }} sx={{ gridColumn: { xs: "1 / -1", sm: "auto" } }} />
        <Button variant="contained" disabled={!address.trim() || openBrowser.isPending || navigate.isPending || session?.controlOwner === "agent"} onClick={submitAddress}>Go</Button>
        <Tooltip title="Restart browser process"><span><IconButton aria-label="Reconnect Project browser" disabled={!session || reconnect.isPending} onClick={() => reconnect.mutate()}><RefreshIcon /></IconButton></span></Tooltip>
        <Button color="inherit" disabled={!session || session.status === "closed" || close.isPending} onClick={() => close.mutate()}>Close browser</Button>
      </Box>

      <Box sx={{ minHeight: 0, aspectRatio: { xs: `${VIEWPORT.width} / ${VIEWPORT.height}`, sm: "auto" }, display: "grid", placeItems: "center", bgcolor: "grey.950", borderRadius: 1, overflow: "hidden", border: 1, borderColor: operator ? "success.main" : "warning.main" }}>
        {session?.status === "opening" || openBrowser.isPending ? <Stack spacing={1} alignItems="center"><CircularProgress /><Typography color="grey.300">Starting browser…</Typography></Stack> : null}
        {session?.status === "failed" ? <Alert severity="error">{session.failure ?? "Browser failed to start."}</Alert> : null}
        {(!session || missing || session.status === "closed") && !openBrowser.isPending ? <Stack spacing={1} alignItems="center"><Typography color="grey.300">No Project browser is open.</Typography><Button variant="contained" onClick={() => openBrowser.mutate(address.trim() || undefined)}>Open browser</Button></Stack> : null}
        {session?.status === "ready" && frameUrl ? <Box component="img" src={frameUrl} alt={`Project browser viewport: ${session.title ?? session.url ?? "page"}`} tabIndex={operator ? 0 : -1}
          onClick={(event) => { if (!operator) return; const rect = event.currentTarget.getBoundingClientRect(); sendInput({ kind: "click", x: (event.clientX - rect.left) * VIEWPORT.width / rect.width, y: (event.clientY - rect.top) * VIEWPORT.height / rect.height }); }}
          onKeyDown={(event) => { if (!operator || event.key === "Tab" || event.key === "Escape") return; event.preventDefault(); sendInput({ kind: "key", key: event.key }); }}
          onWheel={(event) => { if (!operator || Date.now() - wheelAt.current < 120) return; wheelAt.current = Date.now(); sendInput({ kind: "scroll", deltaX: event.deltaX, deltaY: event.deltaY }); }}
          sx={{ width: "100%", height: "100%", objectFit: "contain", display: "block", cursor: operator ? "crosshair" : "default", outlineOffset: -3 }} /> : null}
      </Box>

      <Stack spacing={1}>
        {session?.status === "ready" ? session.controlOwner === "operator" ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField size="small" fullWidth label="Type into focused page control" value={typeText} onChange={(event) => setTypeText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && typeText) { event.preventDefault(); sendInput({ kind: "type", text: typeText }); setTypeText(""); } }} />
          <Button variant="outlined" disabled={!typeText || input.isPending} onClick={() => { sendInput({ kind: "type", text: typeText }); setTypeText(""); }}>Type</Button>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
            {runningAgents.map((agent) => <Button key={agent.id} color="warning" variant="outlined" disabled={control.isPending} onClick={() => control.mutate({ owner: "agent", agentId: agent.id })}>Give {agent.title} control</Button>)}
          </Stack>
        </Stack> : <Stack direction="row" spacing={1} alignItems="center"><Typography variant="body2" sx={{ flex: 1 }}>The selected agent has temporary control for its current Run.</Typography><Button variant="contained" onClick={() => control.mutate({ owner: "operator" })}>Take control back</Button></Stack> : null}
        {operator && runningAgents.length === 0 ? <Typography variant="caption" color="text.secondary">Start an agent Run to make it available for temporary control.</Typography> : null}
        {frameError ? <Alert severity="warning">Live frame disconnected: {frameError}</Alert> : null}
        {error ? <Alert severity="error">{String(error)}</Alert> : null}
      </Stack>
    </DialogContent>
  </>;
  if (embedded) return <Box aria-labelledby="project-browser-title" sx={{ minHeight: 0, minWidth: 0, height: "100%", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", overflow: "hidden" }}>{content}</Box>;
  return <Dialog open={open} onClose={onClose} fullScreen maxWidth={false} aria-labelledby="project-browser-title">{content}</Dialog>;
}
