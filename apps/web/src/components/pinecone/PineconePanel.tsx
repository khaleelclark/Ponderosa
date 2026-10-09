import { useRef, useState } from "react";
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Stack, Typography } from "@mui/material";
import type { AgentDto, ConversationDecisionEventDto, CreateTriggerRequest, TriggerDefinitionDto, UpdateTriggerRequest } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useAgentHealth, usePineconeProfile, usePineconeResponsibilities, usePineconeWork } from "../../hooks/queries";
import { createClientId } from "../../clientId";
import { queryKeys } from "../../queryKeys";
import { DecisionCard } from "../decisions/DecisionCard";
import { useWorkspaceConnection } from "../WorkspaceConnectionContext";
import { PineconeResponsibilityEditor } from "./PineconeResponsibilityEditor";
import { pineconeWorkLabel, responsibilitySchedule, reviewedDefinition } from "./responsibilities";

/** A thin operator view over canonical definitions and work; no admission or task store. */
export function PineconePanel({ agent, visible, decisions, onOpenWork, onOpenAutomations, onOpenFiles }: {
  agent: AgentDto; visible: boolean; decisions: ConversationDecisionEventDto[];
  onOpenWork(focusId?: string): void; onOpenAutomations(): void; onOpenFiles(): void;
}): JSX.Element | null {
  const profile = usePineconeProfile(agent.id);
  const health = useAgentHealth(agent.projectId, Boolean(profile.data));
  const currentHealth = health.data?.agents.find(item => item.agentId === agent.id);
  const currentFinishing = Boolean(currentHealth?.executionId || currentHealth?.schedulerRunId && currentHealth?.leaseExpiresAt);
  const paused = profile.data?.admissionState === "paused";
  const [holdReview, setHoldReview] = useState<import("@ponderosa/core").PineconeProfileDto>();
  const [holdPending, setHoldPending] = useState(false);
  const [holdBlocked, setHoldBlocked] = useState(false);
  const [holdError, setHoldError] = useState<string>();
  const holdBusy = useRef(false);
  const connection = useWorkspaceConnection();
  const client = useQueryClient();
  const identity = profile.data?.agentId === agent.id && profile.data.projectId === agent.projectId && profile.data.conversationId === agent.conversationId;
  const chat = useQuery({ queryKey: queryKeys.conversations.detail(agent.conversationId), queryFn: () => api.getConversation(agent.conversationId), enabled: identity });
  const active = Boolean(identity && chat.data?.conversation.id === agent.conversationId && chat.data.conversation.projectId === agent.projectId && !chat.data.conversation.archived && !chat.data.conversation.deletedAt && !agent.archived);
  const definitions = usePineconeResponsibilities(agent.projectId, agent.conversationId, agent.id, active);
  const work = usePineconeWork(agent.projectId, agent.conversationId, agent.id, active);
  const [view, setView] = useState<"responsibilities" | "activity">();
  const [editor, setEditor] = useState<{ initial?: TriggerDefinitionDto }>();
  const [reviewVersion, setReviewVersion] = useState(0);
  const [action, setAction] = useState<{ kind: "enable" | "disable" | "run"; trigger: TriggerDefinitionDto }>();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const items = definitions.data?.pages.flatMap(page => page.items) ?? [];
  const exact = (trigger: TriggerDefinitionDto) => trigger.projectId === agent.projectId && trigger.conversationId === agent.conversationId && trigger.targetAgentId === agent.id && !trigger.branchId;
  const refresh = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: queryKeys.triggers.all }), client.invalidateQueries({ queryKey: queryKeys.agentWork.all })]);
  };
  const mutate = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (busy.current || blocked || !active) return false;
    busy.current = true; setPending(true); setError(undefined); setNotice(undefined);
    try {
      await operation(); setNotice(success);
      // Reconciliation failure cannot turn a known accepted action into an uncertain write.
      void refresh(); return true;
    } catch (cause) {
      setBlocked(true); setAction(undefined); setConfirmed(false);
      setError(`${cause instanceof Error ? cause.message : "Request failed"} The outcome may be unknown. Reload the current definitions and review them before another action. Check now is never retried automatically.`);
      void definitions.refetch(); return false;
    } finally { busy.current = false; setPending(false); }
  };
  const reloadForReview = async () => {
    if (busy.current) return;
    setPending(true);
    try {
      const [result, destination] = await Promise.all([definitions.refetch(), chat.refetch()]);
      if (result.error || destination.error || !result.data || !destination.data) throw result.error ?? destination.error ?? Error("Current state unavailable");
      if (editor?.initial) {
        const latest = result.data.pages.flatMap(page => page.items).find(trigger => trigger.id === editor.initial!.id);
        if (!latest || !exact(latest)) throw Error("The edited responsibility is no longer in this Pinecone Chat. Its draft is retained; use Automations to review the changed destination.");
        setEditor({ initial: latest }); setReviewVersion(value => value + 1);
      }
      setBlocked(false); setError(undefined); setNotice("Current definitions loaded. Review and deliberately confirm your next action.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Current state unavailable"); }
    finally { setPending(false); }
  };
  const reloadHold = async () => {
    if (holdBusy.current) return;
    holdBusy.current = true; setHoldPending(true);
    try {
      const fresh = await profile.refetch();
      if (fresh.error || !fresh.data) throw fresh.error ?? Error("Current Pinecone state unavailable");
      setHoldReview(undefined); setHoldBlocked(false); setHoldError(undefined);
    } catch (cause) { setHoldError(cause instanceof Error ? cause.message : "Current Pinecone state unavailable"); }
    finally { holdBusy.current = false; setHoldPending(false); }
  };
  const changeHold = async () => {
    if (!holdReview || holdBusy.current || holdBlocked || !active) return;
    holdBusy.current = true; setHoldPending(true); setHoldError(undefined);
    try {
      const result = await api.updatePineconeAdmission(agent.id, {
        admissionState: holdReview.admissionState === "paused" ? "active" : "paused",
        expectedRevision: holdReview.revision, operationKey: createClientId(),
      });
      client.setQueryData(queryKeys.pinecone(agent.id), result); setHoldReview(undefined);
      void profile.refetch(); void health.refetch(); void refresh();
    } catch (cause) {
      setHoldBlocked(true); setHoldReview(undefined);
      setHoldError(`${cause instanceof Error ? cause.message : "Request failed"} The outcome may be unknown. Reload Pinecone for review before another action. Pause and Resume are never retried automatically.`);
      void profile.refetch();
    } finally { holdBusy.current = false; setHoldPending(false); }
  };
  // Retain this Agent's review and in-flight guards across tabs, without off-tab UI or portals.
  if (!visible) return null;
  if (profile.isPending) return <Typography role="status" variant="caption" sx={{ mx: 2 }}>Loading responsibilities…</Typography>;
  if (profile.error) return <Alert severity="warning" sx={{ m: 1 }}>Pinecone responsibilities unavailable.</Alert>;
  if (!identity) return null;
  const stale = connection.status !== "live" || !connection.phaseEvidenceFresh;
  const pendingDecisions = [...new Map(decisions.filter(event => event.decision.agentId === agent.id && event.decision.conversationId === agent.conversationId && event.decision.status === "pending").map(event => [event.decision.id, event.decision])).values()];
  return <>
    <Stack direction="row" useFlexGap flexWrap="wrap" sx={{ px: 1, flexShrink: 0 }}>
      <Typography role="status" variant="body2" sx={{ alignSelf: "center" }}>{paused ? currentFinishing ? "Pausing — current work finishing" : health.isPending || health.error ? "Paused · current work unavailable" : "Paused" : "Pinecone active"}</Typography>
      <Button sx={{ minHeight: 44 }} disabled={!active || holdPending || holdBlocked || stale} onClick={() => setHoldReview(profile.data!)}>{paused ? "Resume Pinecone" : "Pause Pinecone"}</Button>
      <Button sx={{ minHeight: 44 }} onClick={() => setView("responsibilities")}>Responsibilities</Button>
      <Button sx={{ minHeight: 44 }} onClick={() => setView("activity")}>Work & attention{pendingDecisions.length ? ` · ${pendingDecisions.length} decisions` : ""}</Button>
    </Stack>
    <Typography variant="caption" sx={{ px: 2 }}>Pause holds new work and scheduled check-ins. Current work may finish; children continue.</Typography>
    {paused ? <Typography variant="caption" sx={{ px: 2 }}>Messages can queue until resumed. Missed schedules catch up in collapsed checks under their existing budgets.</Typography> : null}
    {holdError ? <Alert severity="warning" sx={{ m: 1 }}>{holdError}</Alert> : null}
    {holdBlocked || stale ? <Button disabled={holdPending} onClick={() => void reloadHold()}>Reload Pinecone for review</Button> : null}
    <Dialog open={Boolean(holdReview)} onClose={() => { if (!holdPending) setHoldReview(undefined); }} fullWidth maxWidth="sm" aria-labelledby="pinecone-hold-title">
      <DialogTitle id="pinecone-hold-title">{holdReview?.admissionState === "paused" ? "Resume Pinecone" : "Pause Pinecone"}</DialogTitle>
      <DialogContent><Typography>{holdReview?.admissionState === "paused" ? "Resume queued work. Missed schedules catch up as collapsed checks under their existing automatic Run budgets; each missed tick is not replayed." : "Hold new work and scheduled check-ins. Current work may finish; children and unrelated Agents continue. Messages, helper results and decisions remain queued until resumed."}</Typography></DialogContent>
      <DialogActions><Button disabled={holdPending} onClick={() => setHoldReview(undefined)}>Cancel</Button><Button disabled={!active || holdPending || holdBlocked || stale} onClick={() => void changeHold()}>{holdPending ? "Submitting…" : "Confirm"}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(view)} onClose={() => { if (!pending) setView(undefined); }} fullWidth maxWidth="sm" aria-labelledby="pinecone-panel-title">
      <DialogTitle id="pinecone-panel-title">{view === "activity" ? "Work & attention" : "Responsibilities"}</DialogTitle>
      <DialogContent><Stack spacing={1.5}>
        {stale ? <Alert severity="warning">Live updates are disconnected or catching up. Refresh to review current state; drafts are retained.</Alert> : null}
        {chat.isPending ? <Typography role="status">Loading destination…</Typography> : !active ? <Alert severity="warning">This Pinecone Chat is unavailable or archived. Configuration actions are unavailable.</Alert> : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
        {notice ? <Alert severity="info" role="status">{notice}</Alert> : null}
        <Button disabled={pending} onClick={() => void reloadForReview()}>Reload for review</Button>
        {view === "responsibilities" ? <>
          <Typography variant="body2">Schedules use this Pinecone's full host authority. Disabling a responsibility stops future intake and cancels queued work that has not been submitted to the Agent. Work already submitted to the Agent and its children continue. Work progresses while your host and Ponderosa are online.</Typography>
          <Button disabled={!active || pending || blocked} onClick={() => { setEditor({}); setReviewVersion(0); }}>Add responsibility</Button>
          {definitions.isPending ? <Typography role="status">Loading responsibilities…</Typography> : null}
          {definitions.error ? <Alert severity="error">Responsibilities could not be loaded. Previously loaded records may be stale.</Alert> : null}
          {!definitions.isPending && !definitions.error && !items.length ? <Typography>No responsibilities configured.</Typography> : null}
          {items.map(trigger => <Box key={trigger.id} component="section" aria-label={`Responsibility ${trigger.name}`} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, overflowWrap: "anywhere" }}>
            <Typography variant="subtitle2">{trigger.name}</Typography>
            <Typography variant="body2">{trigger.enabled ? "Enabled" : "Disabled"} · {responsibilitySchedule(trigger)}</Typography>
            <Typography variant="body2">Next: {trigger.enabled ? trigger.nextFireAt ?? "Unavailable" : "Not scheduled while disabled"} · Last: {trigger.lastFiredAt ?? "No recorded fire"}</Typography>
            <Typography variant="body2">{trigger.runBudget ? `Budget: ${trigger.runBudget.limit} / ${trigger.runBudget.period}` : "Budget: unlimited"}{trigger.budgetState ? ` · ${trigger.budgetState.used} used · ${trigger.budgetState.allowance} additional · ${trigger.budgetState.held ? "Held" : "Not held"}` : " · Usage unavailable"}</Typography>
            <Typography variant="caption" component="p">Source: {trigger.id}</Typography>
            <Stack direction="row" useFlexGap flexWrap="wrap">
              {exact(trigger) && trigger.sourceKind === "schedule" ? <>
                <Button disabled={!active || pending || blocked} onClick={() => { setEditor({ initial: trigger }); setReviewVersion(0); }}>Edit</Button>
                <Button disabled={!active || pending || blocked || (!trigger.enabled && !trigger.runBudget)} onClick={() => { setAction({ kind: trigger.enabled ? "disable" : "enable", trigger }); setConfirmed(false); }}>{trigger.enabled ? "Disable" : "Enable"}</Button>
                <Button disabled={!active || pending || blocked} onClick={() => { setAction({ kind: "run", trigger }); setConfirmed(false); }}>Check now</Button>
              </> : <Typography variant="caption">{exact(trigger) ? "Advanced source" : "Different destination"} · review in Automations</Typography>}
              <Button onClick={onOpenAutomations}>Automations & occurrences</Button>
            </Stack>
          </Box>)}
          {definitions.hasNextPage ? <Button disabled={definitions.isFetchingNextPage} onClick={() => void definitions.fetchNextPage()}>{definitions.isFetchingNextPage ? "Loading…" : "Load more responsibilities"}</Button> : null}
        </> : <>
          <Typography variant="body2">Recent canonical work. Results ready means a recorded result is available for review; it does not imply the whole assignment is complete.</Typography>
          {work.isPending ? <Typography role="status">Loading work…</Typography> : null}
          {work.error ? <Alert severity="error">Current work could not be loaded. Previously loaded records may be stale.</Alert> : null}
          {work.data?.truncated ? <Alert severity="info">This is a bounded recent window. Open Work to inspect connected and older records.</Alert> : null}
          {pendingDecisions.map(decision => <DecisionCard key={decision.id} decision={decision} onResolved={() => void client.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agent.id) })} />)}
          {work.data?.items.map(item => <Box key={item.id} sx={{ borderBottom: 1, borderColor: "divider", pb: 1, overflowWrap: "anywhere" }}>
            <Typography variant="subtitle2">{pineconeWorkLabel(item, agent.id)}</Typography>
            <Typography variant="body2">{item.title}</Typography>
            <Typography variant="caption">Source: {item.id}</Typography>
            <Button onClick={() => onOpenWork(item.id)}>Review {item.kind === "decision" ? "Decision in Work" : "Work"}</Button>
          </Box>)}
          {!work.isPending && !work.error && !work.data?.items.length ? <Typography>No work in the current window.</Typography> : null}
          <Stack direction="row" useFlexGap flexWrap="wrap"><Button onClick={() => onOpenWork()}>Open Work</Button><Button onClick={onOpenFiles}>Files & Results</Button></Stack>
        </>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={pending} onClick={() => setView(undefined)}>Close</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(editor)} onClose={() => { if (!pending) setEditor(undefined); }} fullWidth maxWidth="sm" aria-labelledby="pinecone-editor-title">
      {editor ? <PineconeResponsibilityEditor key={editor.initial?.id ?? "new"} projectId={agent.projectId} conversationId={agent.conversationId} agentId={agent.id}
        initial={editor.initial} reviewVersion={reviewVersion} pending={pending} blocked={blocked || !active} error={error}
        onClose={() => setEditor(undefined)} onReview={() => void reloadForReview()} onSave={request => mutate(() => editor.initial ? api.updateTrigger(editor.initial.id, request as UpdateTriggerRequest) : api.createTrigger(agent.projectId, request as CreateTriggerRequest), "Responsibility saved. Enable requires explicit review and confirmation.")} /> : null}
    </Dialog>
    <Dialog open={Boolean(action)} onClose={() => { if (!pending) setAction(undefined); }} fullWidth maxWidth="sm" aria-labelledby="pinecone-action-title">
      <DialogTitle id="pinecone-action-title">{action?.kind === "run" ? "Check now" : action?.kind === "enable" ? "Enable responsibility" : "Disable responsibility"}</DialogTitle>
      <DialogContent>{action ? <Stack spacing={1}>
        <Typography>{action.trigger.name} · {responsibilitySchedule(action.trigger)}</Typography>
        <Typography>Exact destination: {agent.title} · this Chat</Typography>
        <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{action.trigger.instructions}</Typography>
        <Typography>Automatic budget: {action.trigger.runBudget ? `${action.trigger.runBudget.limit} / ${action.trigger.runBudget.period}` : "Unlimited"}</Typography>
        <Typography>{action.kind === "run" ? `This one-time ${action.trigger.enabled ? "enabled" : "disabled"} check uses full host authority and does not consume the automatic budget.` : action.kind === "enable" ? "This schedule runs with full host authority under your existing Agent settings." : "Disabling stops future intake and cancels queued work not yet submitted to the Agent. Work already submitted and its children continue."}</Typography>
        <FormControlLabel control={<Checkbox checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />} label={action.kind === "disable" ? "I confirm stopping future intake and canceling queued work not yet submitted" : "I confirm this destination, instructions, schedule, budget and full host authority"} />
      </Stack> : null}</DialogContent>
      <DialogActions><Button disabled={pending} onClick={() => setAction(undefined)}>Cancel</Button><Button disabled={!confirmed || pending || blocked || !active} onClick={() => {
        if (!action || !exact(action.trigger)) return;
        const snapshot = action;
        void mutate(() => snapshot.kind === "run" ? api.runTrigger(snapshot.trigger.id, !snapshot.trigger.enabled, reviewedDefinition(snapshot.trigger)) : api.updateTrigger(snapshot.trigger.id, { enabled: snapshot.kind === "enable", reviewedDefinition: reviewedDefinition(snapshot.trigger) }), snapshot.kind === "run" ? "Check accepted. Review its canonical occurrence in Automations or Work." : "Responsibility updated.").then(ok => { if (ok) setAction(undefined); });
      }}>{pending ? "Submitting…" : "Confirm"}</Button></DialogActions>
    </Dialog>
  </>;
}
