import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type AgentDto, type ConversationDetailDto, type ConversationMessageDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { productApiPath } from "../../api/productScope";
import { useWorkspacePreferences } from "../../hooks/queries";
import { queryKeys } from "../../queryKeys";
import { publishConversationMessageReceipt } from "../../conversationMessageReceipt";
import { dictationUnavailableReason, speechSynthesisUnavailableReason } from "./browserSpeech";
import { speechSnapshot, startSpeech, stopSpeech, subscribeSpeech } from "./speechCoordinator";
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";
import { speakableMessageText } from "./speechText";
import { useDictation } from "./useDictation";
import { voiceReplyInWindow } from "./voiceReply";
import { VOICE_ATTEMPT_TTL, prepareVoiceCallAttempt, restoreVoiceCallAttempt, retainVoiceCallAttempt, settleVoiceCallAttempt, voiceCallAttemptCanRetry, type VoiceCallAttempt, type VoiceRoute } from "./voiceCallAttempt";

type Phase = "ready" | "capture" | "review" | "sending" | "queued" | "waiting" | "loading" | "speaking" | "paused";
export interface VoiceConversationContext {
  projectId: string; conversationId: string; agents: AgentDto[];
  selectedAgentId?: string; lockAgent?: boolean;
}
const member = (agent: AgentDto, projectId: string, conversationId: string) => !agent.archived && agent.projectId === projectId && agent.conversationId === conversationId;
export function VoiceConversation(props: VoiceConversationContext & { open: boolean; onClose(): void }): JSX.Element {
  const product = productApiPath("/api/conversations");
  return <>{props.open && <VoiceSession key={JSON.stringify([product, props.projectId, props.conversationId, props.selectedAgentId])} {...props} product={product} />}</>;
}
function VoiceSession({ projectId, conversationId, agents, selectedAgentId, lockAgent, onClose, product }: VoiceConversationContext & { onClose(): void; product: string }): JSX.Element {
  const ownerId = useId();
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const [agentId, setAgentId] = useState(selectedAgentId ?? (agents.length === 1 ? agents[0]!.id : ""));
  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef(phase);
  const changePhase = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [locked, setLocked] = useState(Boolean(lockAgent));
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const [checked, setChecked] = useState(false);
  const [recovering, setRecovering] = useState(true);
  const [retryable, setRetryable] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [messageId, setMessageId] = useState<string>();
  const [transcript, setTranscript] = useState<ConversationMessageDto[]>([]);
  const [playText, setPlayText] = useState<string>();
  const attempt = useRef<VoiceCallAttempt>();
  const route: VoiceRoute = { origin: window.location.origin, product, projectId, conversationId, agentId };
  const routeKey = JSON.stringify(route);
  const queryClient = useQueryClient();
  const { data: workspace } = useWorkspacePreferences();
  const playback = useSyncExternalStore(subscribeSpeech, speechSnapshot);
  const preferences = workspace?.speech ?? DEFAULT_SPEECH_PREFERENCES;
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const sttUnavailable = dictationUnavailableReason();
  const ttsUnavailable = speechSynthesisUnavailableReason();
  const live = agents.some(a => a.id === agentId && member(a, projectId, conversationId));
  const liveRef = useRef(live); liveRef.current = live;
  const dictation = useDictation(words => {
    if (alive.current && liveRef.current && phaseRef.current === "capture") setText(current => [current, words].filter(Boolean).join(" "));
  }, () => {}, root, false);
  const dictationRef = useRef(dictation); dictationRef.current = dictation;
  const abandon = useCallback(() => {
    generation.current++;
    dictationRef.current.abandon();
    stopSpeech(ownerId);
  }, [ownerId]);
  const suspend = useCallback(() => {
    abandon(); changePhase("paused"); setChecked(false);
    setNotice("Call suspended. Unfinished words were discarded; accepted work continues in Chat. Resume deliberately.");
  }, [abandon, changePhase]);
  const end = () => { alive.current = false; attempt.current = undefined; setText(""); abandon(); onClose(); };
  const validateDetail = (detail: ConversationDetailDto) => {
    const chat = detail.conversation;
    return chat.id === conversationId && chat.projectId === projectId && !chat.archived &&
      (product.startsWith("/api/branches/") ? Boolean(chat.branchId) : !chat.branchId) &&
      detail.agents.some(a => a.id === agentId && member(a, projectId, conversationId));
  };
  // Read-only eligibility refresh. Capture still requires a separate visible Listen gesture.
  useEffect(() => {
    let cancelled = false;
    setChecked(false); setRecovering(true); setBlocked(false); setRetryable(false);
    attempt.current = undefined;
    void restoreVoiceCallAttempt(route).then(restored => {
      if (cancelled) return;
      if (restored.notice) setLocked(true);
      setNotice(restored.notice); setRetryable(false);
      setBlocked(Boolean(restored.notice)); setRecovering(false);
    });
    void api.getConversation(conversationId, 20).then(detail => {
      if (!cancelled && alive.current) {
        if (validateDetail(detail)) setChecked(true);
        else { suspend(); setError("This Agent or Chat is unavailable. Open Chat."); }
      }
    }).catch(() => { if (!cancelled) setError("Could not verify the Agent’s current Chat. Open Chat or resume to check again."); });
    return () => { cancelled = true; };
  // routeKey is the frozen complete route identity, not a display label.
  }, [routeKey]);
  useEffect(() => { if (agentId && !live) { suspend(); setError("This Agent is no longer an available member of this Chat."); } }, [live, agentId, suspend]);
  useEffect(() => {
    const cleanup = monitorSpeechSurfaceAccessibility(() => root.current, suspend);
    const navigate = () => suspend();
    window.addEventListener("popstate", navigate); window.addEventListener("hashchange", navigate);
    return () => { cleanup(); window.removeEventListener("popstate", navigate); window.removeEventListener("hashchange", navigate); };
  }, [suspend, surfaceEpoch]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; attempt.current = undefined; abandon(); }; }, [abandon]);
  useEffect(() => {
    if (dictation.status === "error") { changePhase("paused"); setError(dictation.error); }
    else if (dictation.status === "stopped" && phaseRef.current === "capture") changePhase("review");
  }, [dictation.status, dictation.error, changePhase]);
  useEffect(() => {
    if (!["loading", "speaking"].includes(phaseRef.current)) return;
    if (playback.ownerId !== ownerId) { changePhase("ready"); return; }
    if (playback.status === "speaking") changePhase("speaking");
    else if (playback.status === "error" || playback.status === "stopped") {
      changePhase("ready"); if (playback.error) setError(`${playback.error} Use Play reply or read the transcript.`);
    }
  }, [playback, ownerId, changePhase]);
  const listen = () => {
    if (!live || !checked || muted || blocked || recovering || attempt.current || phaseRef.current === "capture") return;
    stopSpeech(); setLocked(true); setError(undefined); changePhase("capture"); dictation.start();
  };
  const resume = async () => {
    const current = ++generation.current;
    try {
      const detail = await api.getConversation(conversationId, 20);
      if (!alive.current || current !== generation.current) return;
      if (!validateDetail(detail)) throw new Error("This Agent or Chat is unavailable.");
      setSurfaceEpoch(value => value + 1); setChecked(true); changePhase("ready"); setError(undefined);
    } catch (failure) { if (alive.current && current === generation.current) setError(String(failure)); }
  };
  const play = (spoken: string, current = generation.current) => {
    if (!alive.current || !liveRef.current || current !== generation.current || phaseRef.current === "capture") return;
    if (ttsUnavailable) { changePhase("ready"); return; }
    changePhase("loading");
    startSpeech(ownerId, spoken, preferencesRef.current, () => root.current, () => {
      if (alive.current && current === generation.current) changePhase("ready");
    });
  };
  const send = async () => {
    if (!live || !checked || recovering || blocked || ["sending", "queued", "waiting", "loading", "speaking", "capture"].includes(phaseRef.current)) return;
    if (attempt.current && Date.now() - attempt.current.marker.createdAt >= VOICE_ATTEMPT_TTL) {
      attempt.current = undefined; setText(""); setBlocked(true); setError("The unconfirmed turn expired. Review Chat before sending again."); return;
    }
    // Set synchronously before hashing/storage/HTTP so two clicks cannot create two keys.
    changePhase("sending"); setLocked(true); setError(undefined);
    const current = ++generation.current;
    let pending = attempt.current;
    try {
      if (pending && (!retryable || !await voiceCallAttemptCanRetry(pending, route))) {
        if (alive.current && current === generation.current) { attempt.current = undefined; setText(""); setBlocked(true); changePhase("paused"); setError("Server identity changed or retry identity could not be confirmed. Review Chat."); }
        return;
      }
      if (!alive.current || current !== generation.current) return;
      if (!pending) {
        const restored = await restoreVoiceCallAttempt(route);
        if (!alive.current || current !== generation.current) return;
        if (restored.notice) { setBlocked(true); setText(""); setNotice(restored.notice); changePhase("paused"); return; }
        pending = await prepareVoiceCallAttempt(route, text.trim(), () => crypto.randomUUID());
        if (!alive.current || current !== generation.current) return;
        const stored = retainVoiceCallAttempt(pending);
        attempt.current = pending; setRetryable(true);
        if (!stored) setNotice("Storage is unavailable. Only this mounted call can retry; reload recovery cannot be guaranteed. Review Chat after closing.");
      }
      const marker = pending.marker;
      const responsePromise = api.sendMultiAgentDirectMessage(marker.route.conversationId, pending.request);
      // The in-flight transport owns its bytes; this coroutine retains only the
      // marker. End/unmount releases the mounted retry payload reference.
      pending = undefined;
      const response = await responsePromise;
      // Settlement is independent of the view generation. Never erase another attempt.
      settleVoiceCallAttempt(marker);
      void publishConversationMessageReceipt(queryClient, marker.route.conversationId, response.message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(marker.route.conversationId) });
      if (!alive.current || generation.current !== current) return;
      attempt.current = undefined; setRetryable(false); setText("");
      if (response.unavailableRecipients?.length) throw new Error("This Agent is unavailable. Check Chat.");
      setMessageId(response.messageId);
      if (response.message) setTranscript(items => [...items.filter(i => i.id !== response.message!.id), response.message!].slice(-20));
      changePhase(response.recipients[0]?.queued ? "queued" : "waiting");
    } catch (failure) {
      if (!alive.current || generation.current !== current) return;
      changePhase("paused");
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500) setBlocked(true);
      setError(`Could not confirm this turn. Its outcome may be unknown; check Chat. ${failure instanceof Error ? failure.message : ""}`);
    } finally { pending = undefined; }
  };
  useEffect(() => {
    if ((phase !== "queued" && phase !== "waiting") || !messageId) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const current = generation.current;
    const valid = () => !cancelled && alive.current && liveRef.current && current === generation.current;
    const fail = (message: string) => { if (valid()) { cancelled = true; clearTimeout(timer); changePhase("paused"); setError(message); } };
    const deadline = setTimeout(() => fail("The Agent is still working after 120 seconds. Open Chat for its reply."), 120_000);
    const poll = async () => {
      try {
        const detail = await api.getConversation(conversationId, 20);
        if (!valid()) return;
        if (!validateDetail(detail)) { suspend(); setError("The call’s Agent or Chat is unavailable."); return; }
        const reply = voiceReplyInWindow(messageId, detail.messages, agentId);
        if (reply) {
          if ("error" in reply) { fail(reply.error); return; }
          const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId)!;
          const receipt = sent.deliveryReceipts!.find(i => i.targetAgentId === agentId)!;
          const execution = receipt.state === "recovered" ? receipt.recoveryExecutionId : receipt.executionId;
          const answer = detail.messages.find(i => i.conversationId === conversationId && i.role === "assistant" && i.communicationIntent === "user_dm" && i.authorAgentId === agentId && i.executionId === execution)!;
          setTranscript(items => [...items.filter(i => i.id !== sent.id && i.id !== answer.id), sent, answer].slice(-20));
          const spoken = speakableMessageText(reply.text);
          clearTimeout(deadline); setPlayText(spoken || undefined);
          if (spoken) play(spoken, current); else { changePhase("ready"); setNotice("Read the canonical reply in the transcript or Chat."); }
          return;
        }
        const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId);
        if (sent?.deliveryReceipts?.some(i => i.targetAgentId === agentId && ["started", "delivered", "processed", "recovering", "recovered"].includes(i.state))) changePhase("waiting");
        timer = setTimeout(() => { void poll(); }, 1500);
      } catch (failure) { fail(failure instanceof Error ? failure.message : "Could not load the reply. Open Chat."); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(deadline); };
  }, [phase === "queued" || phase === "waiting", messageId, conversationId, agentId, ownerId, changePhase, suspend]);
  const recording = ["starting", "listening", "pausing", "stopping"].includes(dictation.status);
  const inFlight = ["sending", "queued", "waiting", "loading", "speaking"].includes(phase);
  const status = phase === "capture" ? dictation.status === "starting" ? "Starting microphone…" : dictation.status === "stopping" ? "Finishing transcript…" : "Listening…"
    : phase === "queued" ? "Queued for the Agent…" : phase === "waiting" ? "Waiting for the Agent…" : phase === "loading" ? "Loading speech…" : phase === "speaking" ? "Speaking…" : phase === "sending" ? "Sending…" : muted ? "Microphone muted" : "Microphone off";
  return <Dialog open fullWidth maxWidth="sm" disableEscapeKeyDown onClose={() => {}}>
    <DialogTitle>Agent call · Preview</DialogTitle>
    <DialogContent ref={root}><Stack spacing={2} sx={{ pt: 1 }}>
      <Typography variant="body2">Private direct message. Listen, finish, review, then send. Browser speech may use the browser vendor’s remote processing. You can type instead.</Typography>
      <TextField select label="Call Agent" value={agentId} disabled={locked || recording || inFlight || Boolean(attempt.current)} onChange={e => setAgentId(e.target.value)}>
        {agents.filter(a => member(a, projectId, conversationId)).map(a => <MenuItem key={a.id} value={a.id}>{a.title}</MenuItem>)}
      </TextField>
      {sttUnavailable && <Alert severity="info">{sttUnavailable} Type your turn below.</Alert>}
      {ttsUnavailable && <Alert severity="info">{ttsUnavailable} Replies remain readable.</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="warning">{error}</Alert>}
      <Box role="status" aria-live="polite">{status}</Box>
      <Box aria-label="Call transcript">{transcript.map(message => <Box key={message.id} sx={{ mb: 1 }}><Typography variant="caption">{message.role === "user" ? "You" : "Agent"}</Typography><Typography sx={{ whiteSpace: "pre-wrap" }}>{message.document ? "Full message available in Chat." : message.text}</Typography></Box>)}</Box>
      <TextField label="Your next turn" multiline minRows={3} value={text} disabled={recording || inFlight || recovering || Boolean(attempt.current) || blocked} onChange={e => setText(e.target.value)} />
      <Typography variant="caption">Tap Listen for every turn. End stops browser audio and discards unsent words; accepted work continues. An unconfirmed send keeps its full private words only in this mounted call for deliberate retry. This tab stores only an identity marker. End, reopening or reload drops the call’s retry payload and requires Chat review; markers cannot reconstruct words. Retry expires after 24 hours, without promising physical browser or network memory erasure. Calls require a visible foreground page.</Typography>
    </Stack></DialogContent>
    <DialogActions sx={{ flexWrap: "wrap" }}>
      <Button onClick={end}>End call</Button><Button onClick={end}>Open Chat</Button>
      <Button onClick={() => { if (!muted) { abandon(); changePhase("paused"); setNotice("Microphone muted. Unfinished words were discarded."); } setMuted(!muted); }}>{muted ? "Unmute microphone" : "Mute microphone"}</Button>
      {(phase === "loading" || phase === "speaking") && <Button onClick={() => { generation.current++; stopSpeech(ownerId); changePhase("ready"); }}>Stop speaking</Button>}
      {phase === "paused" && <Button onClick={() => { void resume(); }}>Resume call</Button>}
      {playText && !inFlight && !recording && !ttsUnavailable && <Button onClick={() => play(playText)}>Play reply</Button>}
      {recording && <Button disabled={dictation.status === "stopping"} onClick={dictation.stop}>Finish turn</Button>}
      <Button disabled={!live || !checked || muted || Boolean(sttUnavailable) || recording || inFlight || recovering || Boolean(attempt.current) || blocked} onClick={listen}>Listen</Button>
      <Button disabled={!live || !checked || !text.trim() || recording || inFlight || recovering || blocked || Boolean(attempt.current && !retryable)} onClick={() => { void send(); }}>{attempt.current ? "Retry same turn" : "Send turn"}</Button>
    </DialogActions>
  </Dialog>;
}
