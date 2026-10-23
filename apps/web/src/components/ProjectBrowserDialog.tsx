import CloseIcon from "@mui/icons-material/Close";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import RefreshIcon from "@mui/icons-material/Refresh";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, Menu, MenuItem, Select, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { SAVED_BROWSER_SCOPE_ID, chatBrowserOwnerId } from "@ponderosa/core";
import { BrowserWindow } from "./browser/BrowserWindow";
import { browserAddress } from "./browser/browserAddress";
import { LocalBrowserSetup } from "./browser/LocalBrowserSetup";
import { HostedManualBrowser } from "./browser/HostedManualBrowser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { BrowserViewport } from "./browser/BrowserViewport";
import { BrowserPageStrip } from "./browser/BrowserPageStrip";
import { BrowserArtifactUpload } from "./browser/BrowserArtifactUpload";
import { projectBrowserAdapter, agentBrowserAdapter, type BrowserSession, type BrowserEndpointAdapter } from "./browser/browserAdapters";
import { useBrowserController } from "./browser/useBrowserController";
import { FeatureErrorBoundary } from "./FeatureErrorBoundary";
import { useBrowserSurfaceFocus } from "./browser/useBrowserSurfaceFocus";
import type { ProjectBrowserRequest } from "./ProjectBrowserContext";

export function ProjectBrowserDialog({ projectId, conversationId, agent, open, request, onRequestHandled, onClose, onDockWidth, embedded = false, workspaceControls, windowOptions, workspaceLabel }: {
  projectId?: string;
  conversationId?: string;
  agent?: { id: string; runId: string };
  open: boolean;
  request?: ProjectBrowserRequest;
  onRequestHandled?(requestId: number): void;
  onClose(): void;
  onDockWidth?(width: number): void;
  embedded?: boolean;
  backLabel?: string;
  workspaceControls?: React.ReactNode;
  workspaceLabel?: string;
  windowOptions?: import("./browser/BrowserWindow").BrowserWindowOptions;
}): JSX.Element {
  const browserSurface = useBrowserSurfaceFocus(open, true);
  const [view, setView] = useState<"chat" | "saved">("chat");
  const queryClient = useQueryClient();
  const locationKey = ["agent-browser-location", projectId, agent?.id, agent?.runId];
  const agentLocation = useQuery({ queryKey: locationKey, queryFn: () => api.getAgentBrowserLocation(projectId!, agent!.id), enabled: Boolean(open && projectId && agent), refetchInterval: browserSurface.visible ? 2_000 : false, refetchOnMount: "always" });
  const agentBrowserKind = agentLocation.data?.kind;
  const chatId = conversationId ?? agentLocation.data?.conversationId;
  const chatOwnerId = chatId ? chatBrowserOwnerId(chatId) : undefined;
  const ownerId = agentBrowserKind === "saved" || (!agent && view === "saved") ? SAVED_BROWSER_SCOPE_ID : chatOwnerId;
  const [promoteOpen, setPromoteOpen] = useState(false);
  const saved = useQuery({ queryKey: ["saved-browser"], queryFn: () => api.getSavedBrowser(), enabled: Boolean(open && !agent) });
  const savedAccess = useQuery({ queryKey: ["saved-browser-access", chatOwnerId], queryFn: () => api.getSavedBrowserAccess(chatOwnerId!), enabled: Boolean(open && !agent && chatOwnerId && view === "saved"), refetchInterval: browserSurface.focused ? 3_000 : false });
  const adapter = useMemo<BrowserEndpointAdapter<BrowserSession>>(() => agent && agentBrowserKind === "run"
    ? agentBrowserAdapter(projectId ?? "", agent.id, agentLocation.data?.runId ?? agent.runId)
    : projectBrowserAdapter(ownerId ?? ""), [ownerId, projectId, agent?.id, agent?.runId, agentBrowserKind, agentLocation.data?.runId]);
  const browser = useBrowserController<BrowserSession>({ adapter, enabled: Boolean(ownerId && open && (!agent || (agentBrowserKind && agentBrowserKind !== "none"))), pollingEnabled: browserSurface.focused });
  useEffect(() => {
    if (agent && open) void agentLocation.refetch();
  }, [open, agent?.id, agent?.runId, browser.session?.id, browser.session?.status, browser.session?.controlEpoch,
    browser.session && "controllerAgentId" in browser.session ? browser.session.controllerAgentId : undefined]);
  useEffect(() => {
    if (!open && agent) queryClient.removeQueries({ queryKey: locationKey, exact: true });
  }, [open, projectId, agent?.id, agent?.runId, queryClient]);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string>();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [fastPreview, setFastPreview] = useState(true);
  const [localSetup, setLocalSetup] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const connectionAttempts = useRef(new Set<string>());
  const [rememberSignIns, setRememberSignIns] = useState<boolean | undefined>(undefined);
  const [agentMenu, setAgentMenu] = useState<HTMLElement | null>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<HTMLDivElement | null>(null);
  const preferences = useQuery({ queryKey: ["chat-browser-preferences", ownerId], queryFn: () => api.getChatBrowserPreferences(ownerId!), enabled: Boolean(ownerId && open && !agent) });
  useEffect(() => { setRememberSignIns(undefined); }, [chatOwnerId]);
  const handledRequest = useRef(0);
  const agentSharedBrowserChanged = Boolean(agent && (agentBrowserKind === "saved" || agentBrowserKind === "chat") &&
    browser.session && (!("controllerAgentId" in browser.session) || browser.session.controllerAgentId !== agent.id));
  const session = agent && (!agentBrowserKind || agentBrowserKind === "none" || agentSharedBrowserChanged) ? undefined : browser.session;
  const failed = session?.status === "failed";
  const [reopenConfirm, setReopenConfirm] = useState(false);
  const manual = session?.status === "ready" && Boolean(session.manualControl && session.manualControl !== "automation");
  const nativeDisplay = Boolean(session?.status === "ready" && session.capabilities?.nativeDisplay);
  const operator = session?.status === "ready" && session.controlOwner === "operator" && !session.localPaused && !manual;
  const manualControl = useMutation({
    mutationFn: (action: "open" | "pause" | "resume" | "connect") => api.hostedBrowserControl(ownerId!, action, session?.id, session?.controlEpoch),
    onSettled: () => { void browser.query.refetch(); },
  });
  useEffect(() => {
    if (!open || agent || !session || localSetup || nativeDisplay) return;
    if (session.manualControl === "automation") connectionAttempts.current.delete(session.id);
    if (session.status !== "ready" || session.manualControl !== "manual" || session.privateSignIn || manualControl.isPending || connectionAttempts.current.has(session.id)) return;
    // One attempt per disconnection, not per poll. Chrome approval failures
    // remain in the usable native browser instead of creating a retry loop.
    connectionAttempts.current.add(session.id);
    manualControl.mutate("connect");
  }, [open, agent, localSetup, nativeDisplay, session?.id, session?.status, session?.manualControl, session?.privateSignIn, manualControl.isPending]);
  const openHosted = useMutation({
    mutationFn: () => api.openProjectBrowser(ownerId!, undefined, view === "saved" ? undefined : rememberSignIns),
    onSettled: () => { void browser.query.refetch(); },
  });
  const reopen = useMutation({
    mutationFn: () => api.openProjectBrowser(ownerId!),
    onSuccess: () => { setReopenConfirm(false); browser.resetMutations(); browser.resumeInput(); manualControl.reset(); handoff.reset(); openHosted.reset(); },
    onSettled: () => { void browser.query.refetch(); },
  });
  const handoff = useMutation({
    mutationFn: async (agentId: string) => {
      if (!session) throw new Error("Open the browser first.");
      if (view === "saved") {
        await api.setSavedBrowserAccess(chatOwnerId!, agentId, true);
        if (session.manualControl === "manual") await api.hostedBrowserControl(ownerId!, "resume", session.id, session.controlEpoch);
        return;
      }
      const connected = session.manualControl === "manual"
        ? await api.hostedBrowserControl(ownerId!, "resume", session.id, session.controlEpoch)
        : session;
      return api.setProjectBrowserControl(ownerId!, { owner: "agent", agentId, controllerProjectId: chatOwnerId, currentOrNext: true, expectedControlEpoch: connected.controlEpoch });
    },
    onSettled: () => { void browser.query.refetch(); void savedAccess.refetch(); void queryClient.invalidateQueries({ queryKey: ["agent-browser-location", projectId] }); },
  });
  const revokeSavedAccess = useMutation({
    mutationFn: (agentId: string) => api.setSavedBrowserAccess(chatOwnerId!, agentId, false),
    onSettled: () => { void savedAccess.refetch(); void browser.query.refetch(); void queryClient.invalidateQueries({ queryKey: ["agent-browser-location", projectId] }); },
  });
  const agents = useQuery({ queryKey: ["browser-chat-agents", chatId], queryFn: () => api.listConversationMembers(chatId!), enabled: Boolean(chatId && open) });
  const promote = useMutation({
    mutationFn: () => api.promoteBrowser(chatOwnerId!, session!.id, session!.controlEpoch),
    onSuccess: async () => { setPromoteOpen(false); await saved.refetch(); setView("saved"); void browser.query.refetch(); },
  });
  useEffect(() => {
    if (!open || !ownerId || !request || agentSharedBrowserChanged || request.requestId === handledRequest.current) return;
    handledRequest.current = request.requestId;
    onRequestHandled?.(request.requestId);
    browser.open.mutate(request.url);
  }, [open, ownerId, request?.requestId, view, agentSharedBrowserChanged]);
  const viewedPage = session?.pages.find(page => page.id === browser.viewedPageId);
  const viewedUrl = viewedPage?.url ?? session?.url;
  useEffect(() => { setAddress(viewedUrl === "about:blank" ? "" : viewedUrl ?? ""); }, [viewedUrl]);
  const navigate = () => {
    const value = address.trim();
    if (!value || !projectId) return;
    let url: string;
    try { url = browserAddress(value); setAddressError(undefined); } catch (error) { setAddressError((error as Error).message); return; }
    if (!session || session.status === "closed" || browser.missing) browser.open.mutate(url);
    else browser.navigate.mutate(url);
  };
  const content = (windowControls?: React.ReactNode) => <FeatureErrorBoundary feature="Browser">
    <Stack ref={browserSurface.root} tabIndex={-1} sx={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      {!chatOwnerId && !agent && view === "chat" ? <Alert severity="info">Choose a Chat from Browser workspaces to open its browser.</Alert> : null}
      <Stack data-browser-drag direction="row" alignItems="center" spacing={.25} sx={{ width: "100%", boxSizing: "border-box", px: .5, height: 26, flexShrink: 0, borderBottom: 1, borderColor: "divider", userSelect: "none", "& .MuiIconButton-root": { p: .25 }, "& .MuiSvgIcon-root": { fontSize: 16 }, "& .MuiButton-root": { minWidth: 0, py: 0, px: .75, fontSize: 12, lineHeight: "24px" } }}>
        {workspaceControls}
        {!agent ? <Select size="small" value={view} onChange={event => setView(event.target.value as "chat" | "saved")} inputProps={{ "aria-label": "Browser to view" }} sx={{ minWidth: 70, maxWidth: 130, fontSize: 12, ".MuiSelect-select": { py: 0, pl: .5 }, ".MuiOutlinedInput-notchedOutline": { border: 0 } }}>
          <MenuItem value="chat">{workspaceLabel ?? "This chat"}</MenuItem><MenuItem value="saved" disabled={!saved.data?.browser}>Saved browser</MenuItem>
        </Select> : <Typography id="project-browser-title" sx={{ fontWeight: 600, flex: 1 }}>{agentBrowserKind === "saved" ? "Saved browser" : agentBrowserKind === "chat" ? "Chat browser" : "Agent browser"}</Typography>}
        {session?.status === "ready" ? (session.localPaused ? <Typography variant="caption">Paused</Typography> : !manual && !operator ? <Button size="small" aria-label="Use myself" disabled={browser.control.isPending} onClick={() => browser.control.mutate({ owner: "operator" })}>Take control</Button> : agent && agentBrowserKind === "run" ? <Button size="small" disabled={browser.control.isPending} onClick={() => browser.control.mutate({ owner: "agent" })}>Return to Agent</Button> : !agent ? <Button size="small" aria-label="Let agent work" disabled={session.manualControl === "connecting" || handoff.isPending} onClick={event => setAgentMenu(event.currentTarget)}>Agent</Button> : null) : null}
        <Box ref={setKeyboardTarget} sx={{ display: "flex", alignItems: "center", flexShrink: 0 }} />
        <Tooltip title="Browser options"><IconButton size="small" aria-label="Browser options" onClick={event => setMenu(event.currentTarget)}><MoreHorizIcon /></IconButton></Tooltip>
        {windowControls}
        <Box sx={{ flexGrow: 1, minWidth: 0 }} />
        <Tooltip title="Close panel (keep browser running)"><IconButton size="small" aria-label="Close browser panel" onClick={onClose} sx={{ flexShrink: 0 }}><CloseIcon /></IconButton></Tooltip>
      </Stack>
      <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
        {session?.manualControl ? <MenuItem disabled={manualControl.isPending || (!manual && !operator)} onClick={() => { setMenu(null); manualControl.mutate("pause"); }}>Browser controls & sign-in</MenuItem> : null}
        <MenuItem disabled>{session?.profileMode === "trusted" ? "Sign-ins remembered" : "Temporary browsing"}</MenuItem>
        <MenuItem onClick={() => { setMenu(null); setHelpOpen(true); }}>Browser help</MenuItem>
        {session?.status === "ready" && session.location !== "local" ? <MenuItem onClick={() => { setFastPreview(current => !current); setMenu(null); }}>{fastPreview ? "Use compatibility preview" : "Use faster preview"}</MenuItem> : null}
        {session?.status === "ready" && operator ? <MenuItem onClick={() => { setMenu(null); browser.control.mutate({ owner: "operator" }); }}>Use myself</MenuItem> : null}
        {!agent && view === "chat" ? <MenuItem disabled={!session || session.status !== "ready" || session.controlOwner !== "operator" || Boolean(saved.data?.browser)} onClick={() => { setMenu(null); setPromoteOpen(true); }}>Save browser across chats…</MenuItem> : null}
        {!agent && session?.manualControl === "automation" ? <MenuItem disabled={manualControl.isPending} onClick={() => { setMenu(null); manualControl.mutate("pause"); }}>Sign in privately (disconnect agent access)</MenuItem> : null}
        {session?.nextRunAgentId ? <MenuItem onClick={() => { browser.control.mutate({ owner: "operator", nextRun: true }); setMenu(null); }}>Cancel next-run access</MenuItem> : null}
        {view === "saved" ? (agents.data ?? []).filter(candidate => savedAccess.data?.agentIds.includes(candidate.id)).map(candidate => <MenuItem key={candidate.id} disabled={revokeSavedAccess.isPending} onClick={() => { setMenu(null); revokeSavedAccess.mutate(candidate.id); }}>Revoke {candidate.title}'s saved-browser access</MenuItem>) : null}
        <MenuItem disabled={!session || Boolean(session.manualControl) || session.location === "local" || browser.reconnect.isPending || browser.inputPending} onClick={() => { if (window.confirm("Restart this browser? Unsaved page input may be lost.")) browser.reconnect.mutate(); setMenu(null); }}>Restart browser…</MenuItem>
        <MenuItem disabled={!session || browser.close.isPending || browser.inputPending} onClick={() => { if (window.confirm(session?.location === "local" ? "Disconnect this local window? Its tabs will stay open in your browser." : "End this browser session? Unsaved page input will be lost.")) browser.close.mutate(); setMenu(null); }}>{session?.location === "local" ? "Disconnect local browser" : "End browser session"}</MenuItem>
      </Menu>
      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="xs" fullWidth><DialogTitle>Browser controls</DialogTitle><DialogContent>Open the browser to use Ponderosa’s tabs, address bar, and page controls. {session?.manualControl ? "For a private sign-in or a Chrome-only prompt, choose Browser controls & sign-in; this temporarily disconnects Agent access and shows Chrome itself. Choose Done signing in to return to Ponderosa’s view of the same tabs. " : session ? "The separate native hosted desktop and private sign-in controls require Linux; on macOS and Windows, use the in-app browser controls. " : ""}Agents only receive access when you choose Agent. Closing a panel keeps its browser running.</DialogContent><DialogActions><Button onClick={() => setHelpOpen(false)}>Done</Button></DialogActions></Dialog>
      <Dialog open={promoteOpen} onClose={() => { if (!promote.isPending) setPromoteOpen(false); }} maxWidth="xs" fullWidth>
        <DialogTitle>Save this browser across chats?</DialogTitle>
        <DialogContent><Typography>This keeps the same tabs and sign-ins. All authorized operators of this Ponderosa instance can access it. Agents still need explicit permission. The original chat will no longer own this browser.</Typography><Typography variant="body2" sx={{ mt: 1 }}>Remember sign-ins must already be enabled. {session?.capabilities?.retainedAcrossAppRestart ? "This browser stays running during app restarts. Ending the browser or restarting its host still closes live tabs." : "This browser is not independently supervised; app restarts close live tabs."}</Typography>{promote.error ? <Alert severity="error" sx={{ mt: 1 }}>{promote.error.message}</Alert> : null}</DialogContent>
        <DialogActions><Button disabled={promote.isPending} onClick={() => setPromoteOpen(false)}>Cancel</Button><Button disabled={promote.isPending} onClick={() => promote.mutate()}>Save browser</Button></DialogActions>
      </Dialog>
      <Menu anchorEl={agentMenu} open={Boolean(agentMenu)} onClose={() => setAgentMenu(null)}>
        {(agents.data ?? []).map(candidate => <MenuItem key={candidate.id} disabled={view === "saved" && savedAccess.data?.agentIds.includes(candidate.id)} onClick={() => { setAgentMenu(null); handoff.mutate(candidate.id); }}>{view === "saved" ? savedAccess.data?.agentIds.includes(candidate.id) ? `${candidate.title} · already allowed` : `Allow ${candidate.title} until revoked` : candidate.title}</MenuItem>)}
        {!agents.data?.length ? <MenuItem disabled>No agents in this chat</MenuItem> : null}
      </Menu>
      {localSetup && projectId ? <LocalBrowserSetup projectId={chatOwnerId!} session={session} onClose={() => setLocalSetup(false)} onConnected={() => { setLocalSetup(false); void browser.query.refetch(); }} /> : null}
      {!failed && manualControl.error ? <Alert severity="error" action={nativeDisplay || session?.privateSignIn
        ? <Button onClick={() => { manualControl.reset(); void browser.query.refetch(); }}>Refresh state</Button>
        : <Button onClick={() => manualControl.mutate("resume")}>Retry connection</Button>} onClose={() => manualControl.reset()}>{manualControl.error.message}</Alert> : null}
      {!failed && handoff.error ? <Alert severity="error" onClose={() => handoff.reset()}>{handoff.error.message}</Alert> : null}
      {revokeSavedAccess.error ? <Alert severity="error" onClose={() => revokeSavedAccess.reset()}>{revokeSavedAccess.error.message}</Alert> : null}
      {view === "saved" && savedAccess.error ? <Alert severity="warning" action={<Button onClick={() => void savedAccess.refetch()}>Retry</Button>}>Saved-browser permissions could not be loaded.</Alert> : null}
      {!failed && openHosted.error ? <Alert severity="error">{openHosted.error.message}</Alert> : null}
      {addressError ? <Alert severity="warning" onClose={() => setAddressError(undefined)}>{addressError}</Alert> : null}
      {failed ? <Alert severity="warning" action={!agent && session.location !== "local" ? <Button onClick={() => { reopen.reset(); setReopenConfirm(true); }}>{view === "saved" ? "Reopen saved browser" : "Reopen browser"}</Button> : undefined}>The browser or its display is unavailable. No replacement was opened. Unsaved forms may not be recoverable.</Alert> : null}
      <Dialog open={reopenConfirm} onClose={() => { if (!reopen.isPending) setReopenConfirm(false); }} maxWidth="xs" fullWidth>
        <DialogTitle>{view === "saved" ? "Reopen saved browser?" : "Reopen browser?"}</DialogTitle>
        <DialogContent><Typography>This replaces the failed session. Any remaining browser window will close. Your existing sign-in profile will be reused when available, but websites may ask you to sign in again. Unsaved forms and open tabs are not guaranteed to return.</Typography>{reopen.error ? <Alert severity="error" sx={{ mt: 1 }}>{reopen.error.message}</Alert> : null}</DialogContent>
        <DialogActions><Button disabled={reopen.isPending} onClick={() => setReopenConfirm(false)}>Cancel</Button><Button disabled={reopen.isPending} onClick={() => reopen.mutate()}>{reopen.isPending ? "Reopening…" : "Reopen"}</Button></DialogActions>
      </Dialog>
      {view === "saved" && !agent && savedAccess.data?.agentIds.length ? <Typography role="status" variant="caption" sx={{ px: 1.5, py: .5 }}>Saved-browser access: {savedAccess.data.agentIds.map(id => (agents.data ?? []).find(item => item.id === id)?.title ?? "an agent").join(", ")}. Access survives Runs until revoked.</Typography> : null}
      {session?.nextRunAgentId ? <Typography role="status" variant="caption" sx={{ px: 1.5, py: .5 }}>Ready for {(agents.data ?? []).find(item => item.id === session.nextRunAgentId)?.title ?? "the selected agent"}’s next run only.</Typography> : null}
      {manual && projectId && session && !localSetup ? <>
        {manual && !manualControl.error && !handoff.error ? <Stack direction="row" alignItems="center" sx={{ px: 1, minHeight: 32 }}><Typography role="status" variant="caption" sx={{ flex: 1 }}>{session.manualControl === "connecting" ? "Approve the connection if Chrome asks." : session.privateSignIn ? "Private sign-in · agent access disconnected" : "Chrome is not connected for agent use. Your tabs remain open."}</Typography>{session.manualControl === "connecting" ? <Button size="small" onClick={() => manualControl.mutate("pause")}>Cancel</Button> : <Button size="small" disabled={manualControl.isPending} onClick={() => manualControl.mutate("resume")}>{session.privateSignIn ? "Done signing in" : "Connect for agent"}</Button>}</Stack> : null}
        <HostedManualBrowser projectId={ownerId!} sessionId={session.id} epoch={session.controlEpoch} responsive={nativeDisplay} readOnly={session.controlOwner !== "operator"} connectionSetup={manual} keyboardTarget={keyboardTarget} />
      </> : null}
      {session?.localPaused && !localSetup ? <Alert severity="info" sx={{ m: 2 }}>Your window is still paired. Browser control and the live preview are paused. Sign in or browse directly in Chrome/Edge, then choose <strong>Resume browser access</strong> in the Ponderosa extension. No new pairing code is needed.</Alert> : null}
      {agent && !agentBrowserKind ? <Typography role="status" sx={{ m: 2 }}>Finding this agent's browser…</Typography> : null}
      {agent && agentBrowserKind === "none" ? <Alert severity="info" sx={{ m: 2 }}>This agent has no browser open. It can open a temporary browser during its next Run, or you can allow it to use the saved browser.</Alert> : null}
      {agentSharedBrowserChanged ? <Alert severity="info" sx={{ m: 2 }}>This Agent no longer controls that browser. Waiting for its current browser location…</Alert> : null}
      <Stack sx={{ flex: 1, minHeight: 0, display: (agent && (!agentBrowserKind || agentBrowserKind === "none" || agentSharedBrowserChanged)) || failed || localSetup || session?.localPaused || manual ? "none" : "flex" }}>
      <Box sx={{ px: 1, pt: .75 }}><BrowserPageStrip pages={manual ? [] : session?.pages ?? []} activePageId={browser.viewedPageId} agentPageId={!operator ? session?.activePageId : undefined} loadingPageId={browser.navigate.isPending ? browser.viewedPageId : undefined} canManage={operator} busy={browser.inputPending || browser.navigate.isPending || browser.activatePage.isPending || browser.closePage.isPending || browser.newPage.isPending} onActivate={browser.viewPage} onClose={id => browser.closePage.mutate(id)} onNew={session?.capabilities?.multiPage ? () => browser.newPage.mutate() : undefined} /></Box>
      {!operator && session?.status === "ready" ? <Button size="small" aria-pressed={browser.followAgent} onClick={() => browser.setFollowAgent(!browser.followAgent)} sx={{ alignSelf: "flex-start", mx: 1 }}>{browser.followAgent ? "Following agent" : "Follow agent"}</Button> : null}
      <Stack component="form" direction="row" spacing={.25} sx={{ px: .5, py: .25, alignItems: "center", "& .MuiIconButton-root": { p: .5 }, "& .MuiSvgIcon-root": { fontSize: 16 }, "& input": { py: .5, px: 1, fontSize: 12 } }} onSubmit={event => { event.preventDefault(); navigate(); }}>
        <Tooltip title="Back"><span><IconButton aria-label="Browser back" disabled={!operator || Boolean(browser.inputError)} onClick={() => browser.sendInput({ kind: "key", key: "BrowserBack" })}><ArrowBackIcon /></IconButton></span></Tooltip>
        <Tooltip title="Forward"><span><IconButton aria-label="Browser forward" disabled={!operator || Boolean(browser.inputError)} onClick={() => browser.sendInput({ kind: "key", key: "BrowserForward" })}><ArrowForwardIcon /></IconButton></span></Tooltip>
        <Tooltip title="Reload page"><span><IconButton aria-label="Reload page" disabled={!operator || Boolean(browser.inputError)} onClick={() => browser.sendInput({ kind: "key", key: "BrowserRefresh" })}><RefreshIcon /></IconButton></span></Tooltip>
        <TextField size="small" fullWidth placeholder="Search or enter a URL" inputProps={{ "aria-label": "Website address", autoCapitalize: "none", spellCheck: false }} value={manual ? "" : address} onChange={event => setAddress(event.target.value)} onFocus={event => event.target.select()} disabled={manual || session?.controlOwner === "agent"} />
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", display: "grid" }}>
        <BrowserViewport adapter={adapter} session={manual || failed ? undefined : session} viewedPageId={browser.viewedPageId} active={open && !failed && !localSetup && !session?.localPaused && !manual} pollingEnabled={browserSurface.focused || (browserSurface.visible && browser.followAgent && session?.controlOwner === "agent")} operatorControl={operator && !browser.inputError} sendInput={browser.sendInput} refreshFrame={browser.refreshFrame} preferBinary={fastPreview} accent="divider" keyboardTarget={keyboardTarget} empty={browser.queryError ? <Alert severity="error">Browser could not be loaded. <Button onClick={() => void browser.query.refetch()}>Retry</Button></Alert> : <Stack alignItems="center" spacing={1}><Typography color="text.secondary">{view === "saved" ? "Reopen your saved browser profile. Previous unsaved tabs are not restored." : "Open a website to get started."}</Typography>{!agent && view === "chat" ? <FormControlLabel control={<Checkbox checked={rememberSignIns ?? preferences.data?.rememberSignIns ?? false} onChange={(_, checked) => setRememberSignIns(checked)} />} label="Remember sign-ins in this chat" /> : null}<Button disabled={!ownerId || openHosted.isPending || (!agent && preferences.isPending)} onClick={() => agent ? browser.open.mutate(undefined) : openHosted.mutate()}>Open browser</Button></Stack>} />
      </Box>
      {session?.pendingFileChooser && projectId ? <Box sx={{ p: 1 }}>{view === "saved" && !agent ? <Alert severity="info" action={operator ? <Button onClick={() => browser.cancelFileChooser.mutate()}>Cancel upload</Button> : undefined}>Saved-browser uploads currently require an explicitly authorized agent using files from its chat.</Alert> : <BrowserArtifactUpload projectId={projectId} conversationId={chatId} disabled={browser.upload.isPending} pending={browser.upload.isPending} chooser={session.pendingFileChooser} controlOwner={session.controlOwner} pageUrl={session.url} onUpload={artifactId => browser.upload.mutate({ artifactId })} onCancel={() => browser.cancelFileChooser.mutate()} />}</Box> : null}
      {browser.inputError ? <Alert severity="warning" action={<Button onClick={browser.resumeInput}>Continue</Button>}>{browser.inputError.message}</Alert> : null}
      {browser.error ? <Alert severity="error">{String(browser.error instanceof Error ? browser.error.message : browser.error)}</Alert> : null}
      </Stack>
    </Stack>
  </FeatureErrorBoundary>;
  if (embedded) return <Box sx={{ height: "100%", minHeight: 0 }}>{content()}</Box>;
  return open ? <BrowserWindow {...windowOptions} onClose={onClose} onDockWidth={onDockWidth}>{content}</BrowserWindow> : <></>;
}
