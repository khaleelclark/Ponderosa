import CloseIcon from "@mui/icons-material/Close";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Alert, Box, Button, Chip, Dialog, DialogContent, DialogTitle,
  IconButton, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import type { ProjectBrowserSessionDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { BrowserViewport } from "./browser/BrowserViewport";
import { BrowserPageStrip } from "./browser/BrowserPageStrip";
import { BrowserArtifactUpload } from "./browser/BrowserArtifactUpload";
import { projectBrowserAdapter } from "./browser/browserAdapters";
import { useBrowserController } from "./browser/useBrowserController";
import { FeatureErrorBoundary } from "./FeatureErrorBoundary";
import type { ProjectBrowserRequest } from "./ProjectBrowserContext";

export function ProjectBrowserDialog({
  projectId, open, request, onRequestHandled, onClose, embedded = false, backLabel = "Back to Project",
}: {
  projectId?: string;
  open: boolean;
  request?: ProjectBrowserRequest;
  onRequestHandled?(requestId: number): void;
  onClose(): void;
  embedded?: boolean;
  backLabel?: string;
}): JSX.Element {
  const adapter = useMemo(() => projectBrowserAdapter(projectId ?? ""), [projectId]);
  const [address, setAddress] = useState("");
  const [typeText, setTypeText] = useState("");
  const handledRequest = useRef(0);
  const browser = useBrowserController<ProjectBrowserSessionDto>({
    adapter,
    enabled: Boolean(projectId && open),
    onSession: (next) => {
      if (next.url && next.url !== "about:blank") setAddress(next.url);
    },
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.project(projectId),
    queryFn: () => api.listAgents(projectId!),
    enabled: Boolean(projectId && open),
    refetchOnMount: "always",
    refetchInterval: 4_000,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.agents.health(projectId),
    queryFn: () => api.getAgentHealth(projectId!),
    enabled: Boolean(projectId && open),
    refetchInterval: 4_000,
  });
  const session = browser.session;
  const runningIds = new Set((healthQuery.data?.agents ?? []).filter((agent) => agent.status === "running").map((agent) => agent.agentId));
  const runningAgents = (agentsQuery.data ?? []).filter((agent) => runningIds.has(agent.id));
  const controllerName = (agentsQuery.data ?? []).find((agent) => agent.id === session?.controllerAgentId)?.title;
  const operator = session?.status === "ready" && session.controlOwner === "operator";

  useEffect(() => {
    if (!open || !projectId || !request || request.requestId === handledRequest.current) return;
    handledRequest.current = request.requestId;
    onRequestHandled?.(request.requestId);
    if (request.url) setAddress(request.url);
    browser.open.mutate(request.url);
  }, [open, projectId, request?.requestId, onRequestHandled]);

  useEffect(() => {
    if (session?.url && session.url !== "about:blank") setAddress(session.url);
  }, [session?.url]);

  useEffect(() => {
    if (!open) browser.resetMutations();
  }, [open]);

  const submitAddress = () => {
    const url = address.trim();
    if (!url || !projectId) return;
    if (!session || browser.missing || session.status === "closed") browser.open.mutate(url);
    else browser.navigate.mutate(url);
  };
  const submitText = () => {
    if (!typeText) return;
    browser.sendInput({ kind: "type", text: typeText });
    setTypeText("");
  };
  const noSession = (!session || browser.missing || session.status === "closed")
    && !browser.open.isPending
    && !browser.queryError;
  const queryErrorMessage = browser.queryError instanceof Error
    ? browser.queryError.message
    : browser.queryError
      ? String(browser.queryError)
      : undefined;

  const content = <FeatureErrorBoundary feature="Interactive browser">
    <DialogTitle id="project-browser-title">
      <Stack spacing={.25}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          {embedded ? <Tooltip title={backLabel}><IconButton aria-label={backLabel} onClick={onClose}><ArrowBackIcon /></IconButton></Tooltip> : null}
          <Typography variant="h6" noWrap sx={{ flex: 1, minWidth: 0 }}>Interactive Browser</Typography>
          {session?.status === "ready" ? <Chip size="small" variant="outlined" color={operator ? "success" : "warning"} label={operator ? "You have control" : `${controllerName ?? "Agent"} has control`} /> : null}
          {!embedded ? <Tooltip title="Close Panel"><IconButton aria-label="Close Interactive Browser" onClick={onClose}><CloseIcon /></IconButton></Tooltip> : null}
        </Stack>
        <Typography variant="caption" color="text.secondary">Project-scoped session · persists across Agent Runs until closed</Typography>
      </Stack>
    </DialogTitle>
    <DialogContent dividers sx={{ p: { xs: 1, sm: 2 }, display: "grid", gridTemplateRows: { xs: "auto auto auto", sm: "auto minmax(0, 1fr) auto" }, alignContent: { xs: "start", sm: "stretch" }, gap: 1, minHeight: 0 }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr) auto auto", sm: "minmax(0, 1fr) auto auto auto" }, gap: 1 }}>
        <TextField size="small" fullWidth label="Address" value={address} onChange={(event) => setAddress(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitAddress(); }} sx={{ gridColumn: { xs: "1 / -1", sm: "auto" } }} />
        <Button variant="contained" disabled={!address.trim() || browser.open.isPending || browser.navigate.isPending || Boolean(browser.queryError) || session?.controlOwner === "agent"} onClick={submitAddress}>Go</Button>
        <Tooltip title="Restart Browser Process"><span><IconButton aria-label="Reconnect Interactive Browser" disabled={!session || browser.reconnect.isPending} onClick={() => browser.reconnect.mutate()}><RefreshIcon /></IconButton></span></Tooltip>
        <Button color="inherit" disabled={!session || session.status === "closed" || browser.close.isPending} onClick={() => browser.close.mutate()}>Close Browser</Button>
      </Box>
      <Box sx={{ display: "grid", gap: 1, minHeight: 0 }}>
        <BrowserPageStrip
          pages={session?.pages ?? []}
          activePageId={session?.activePageId}
          canManage={operator}
          busy={browser.activatePage.isPending || browser.closePage.isPending}
          onActivate={(pageId) => browser.activatePage.mutate(pageId)}
          onClose={(pageId) => browser.closePage.mutate(pageId)}
        />
      <BrowserViewport
        adapter={adapter}
        session={session}
        active={open}
        operatorControl={operator}
        sendInput={browser.sendInput}
        refreshFrame={browser.refreshFrame}
        accent="success.main"
        empty={queryErrorMessage
          ? <Alert
              severity="error"
              action={<Button color="inherit" size="small" onClick={() => void browser.query.refetch()}>Retry</Button>}
            >
              Interactive browser could not be loaded. {queryErrorMessage}
            </Alert>
          : noSession
            ? <Stack spacing={1} alignItems="center"><Typography color="grey.300">No Interactive Browser is open.</Typography><Button variant="contained" onClick={() => browser.open.mutate(address.trim() || undefined)}>Open Browser</Button></Stack>
            : undefined}
      />
      </Box>
      <Stack spacing={1}>
        {session?.status === "ready" ? operator ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField size="small" fullWidth label="Type into focused page control" value={typeText} onChange={(event) => setTypeText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitText(); } }} />
          <Button variant="outlined" disabled={!typeText || browser.input.isPending} onClick={submitText}>Type</Button>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
            {runningAgents.map((agent) => <Button key={agent.id} color="warning" variant="outlined" disabled={browser.control.isPending} onClick={() => browser.control.mutate({ owner: "agent", agentId: agent.id })}>Give {agent.title} Control</Button>)}
          </Stack>
        </Stack> : <Stack direction="row" spacing={1} alignItems="center"><Typography variant="body2" sx={{ flex: 1 }}>The selected Agent has temporary control for its current Run.</Typography><Button variant="contained" onClick={() => browser.control.mutate({ owner: "operator" })}>Take Control Back</Button></Stack> : null}
        {projectId && session?.capabilities.fileUpload && (operator || session.pendingFileChooser) ? (
          <BrowserArtifactUpload
            projectId={projectId}
            disabled={browser.upload.isPending || browser.cancelFileChooser.isPending}
            pending={browser.upload.isPending || browser.cancelFileChooser.isPending}
            chooser={session?.pendingFileChooser}
            controlOwner={session?.controlOwner ?? "operator"}
            pageUrl={session?.url}
            onUpload={(artifactId, selector) => browser.upload.mutate({ artifactId, selector })}
            onCancel={() => browser.cancelFileChooser.mutate()}
          />
        ) : null}
        {operator && runningAgents.length === 0 ? <Typography variant="caption" color="text.secondary">Start an Agent Run to make it available for temporary control.</Typography> : null}
        {browser.error ? <Alert severity="error">{browser.error instanceof Error ? browser.error.message : String(browser.error)}</Alert> : null}
      </Stack>
    </DialogContent>
  </FeatureErrorBoundary>;
  if (embedded) return <Box aria-labelledby="project-browser-title" sx={{ minHeight: 0, minWidth: 0, height: "100%", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", overflow: "hidden" }}>{content}</Box>;
  return <Dialog open={open} onClose={onClose} fullScreen maxWidth={false} aria-labelledby="project-browser-title">{content}</Dialog>;
}
