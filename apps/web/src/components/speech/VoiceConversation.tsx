import PhoneIcon from "@mui/icons-material/Phone";
import CallEndIcon from "@mui/icons-material/CallEnd";
import MicOffIcon from "@mui/icons-material/MicOff";
import MicNoneIcon from "@mui/icons-material/MicNone";
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type AgentDto, type ConversationDetailDto, type ConversationMessageDto } from "@ponderosa/core";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
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
  const root = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const [agentId, setAgentId] = useState(() => {
    const eligible = agents.filter(a => member(a, projectId, conversationId));
    return selectedAgentId ?? (eligible.length === 1 ? eligible[0]!.id : "");
  });
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef(phase);
  const changePhase = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);
  const [text, setText] = useState("");
  const textRef = useRef(text); textRef.current = text;
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const stopAutomatic = useCallback(() => { handsFreeRef.current = false; setHandsFree(false); }, []);
  const listenRef = useRef<() => void>(() => {});
  const timing = useRef<{ settled: number; accepted?: number; reply?: number; speech?: number }>();
  const [latency, setLatency] = useState<string>();
  const replyRead = useRef<Promise<ConversationDetailDto>>();
  const publishTiming = () => {
    const t = timing.current;
    if (!t || t.accepted === undefined) return;
    setLatency(`Last turn: settled → accepted ${Math.round(t.accepted - t.settled)} ms${t.reply === undefined ? "" : ` · accepted → canonical reply ${Math.round(t.reply - t.accepted)} ms`}${t.speech === undefined || t.reply === undefined ? "" : ` · reply → speech started ${Math.round(t.speech - t.reply)} ms`}.`);
  };
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [locked, setLocked] = useState(Boolean(lockAgent));
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const mountSurface = useCallback((node: HTMLDivElement | null) => {
    root.current = node;
    if (node) setSurfaceEpoch(value => value + 1);
  }, []);
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
  }, () => {}, root, false, () => handsFreeRef.current);
  const dictationRef = useRef(dictation); dictationRef.current = dictation;
  const abandon = useCallback(() => {
    generation.current++;
    dictationRef.current.abandon();
    stopSpeech(ownerId);
  }, [ownerId]);
  const suspend = useCallback(() => {
    stopAutomatic(); abandon(); changePhase("paused"); setChecked(false);
    setNotice("Call suspended. Unfinished words were discarded; accepted work continues in Chat. Resume deliberately.");
  }, [abandon, changePhase, stopAutomatic]);
  const end = () => { stopAutomatic(); alive.current = false; attempt.current = undefined; setText(""); abandon(); onClose(); };
  const validateDetail = (detail: ConversationDetailDto) => {
    const chat = detail.conversation;
    return chat.id === conversationId && chat.projectId === projectId && !chat.archived &&
      (product.startsWith("/api/branches/") ? Boolean(chat.branchId) : !chat.branchId) &&
      detail.agents.some(a => a.id === agentId && member(a, projectId, conversationId));
  };
  // Read-only eligibility refresh. Capture still requires a separate visible Start call or Listen gesture.
  useEffect(() => {
    let cancelled = false;
    setChecked(false); setRecovering(true); setBlocked(false); setRetryable(false);
    attempt.current = undefined;
    if (!agentId) { setRecovering(false); return; }
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
    // Dialog content mounts through a portal after the session’s first effect.
    // Arm the foreground guard when its actual surface exists.
    if (!root.current) return;
    const cleanup = monitorSpeechSurfaceAccessibility(() => root.current, suspend);
    const navigate = () => suspend();
    window.addEventListener("popstate", navigate); window.addEventListener("hashchange", navigate);
    return () => { cleanup(); window.removeEventListener("popstate", navigate); window.removeEventListener("hashchange", navigate); };
  }, [suspend, surfaceEpoch]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; attempt.current = undefined; abandon(); }; }, [abandon]);
  useEffect(() => {
    if (dictation.status === "error") { stopAutomatic(); changePhase("paused"); setError(dictation.error); }
    else if (dictation.status === "stopped" && phaseRef.current === "capture" && !handsFreeRef.current) changePhase("review");
  }, [dictation.status, dictation.error, changePhase, stopAutomatic]);
  useEffect(() => {
    if (!["loading", "speaking"].includes(phaseRef.current)) return;
    if (playback.ownerId !== ownerId) { stopAutomatic(); changePhase("ready"); return; }
    if (playback.status === "speaking") changePhase("speaking");
    else if (playback.status === "error" || playback.status === "stopped") {
      stopAutomatic(); changePhase("ready"); if (playback.error) setError(`${playback.error} Use Play reply or read the transcript.`);
    }
  }, [playback, ownerId, changePhase, stopAutomatic]);
  const listen = () => {
    if (!live || !checked || muted || blocked || recovering || attempt.current || phaseRef.current === "capture") return;
    if (!stopSpeech()) { stopAutomatic(); setError(speechSnapshot().error); return; }
    setLocked(true); setError(undefined); changePhase("capture"); dictation.start();
  };
  listenRef.current = listen;
  const startCall = () => { if (textRef.current.trim()) return; handsFreeRef.current = true; setHandsFree(true); listen(); };
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
    if (ttsUnavailable) { stopAutomatic(); changePhase("ready"); setNotice("Read the reply in Chat, then start the call deliberately."); return; }
    changePhase("loading");
    startSpeech(ownerId, spoken, preferencesRef.current, () => root.current, () => {
      if (alive.current && current === generation.current) {
        changePhase("ready");
        if (handsFreeRef.current) listenRef.current();
      }
    }, () => {
      if (alive.current && current === generation.current && timing.current) {
        timing.current.speech = performance.now(); publishTiming();
      }
    });
  };
  const send = async () => {
    if (!live || !checked || recovering || blocked || ["sending", "queued", "waiting", "loading", "speaking", "capture"].includes(phaseRef.current)) return;
    if (attempt.current && Date.now() - attempt.current.marker.createdAt >= VOICE_ATTEMPT_TTL) {
      attempt.current = undefined; setText(""); stopAutomatic(); setBlocked(true); setError("The unconfirmed turn expired. Review Chat before sending again."); return;
    }
    if (!attempt.current && !textRef.current.trim()) return;
    if (!attempt.current && (!timing.current || timing.current.accepted !== undefined)) timing.current = { settled: performance.now() };
    // Set synchronously before hashing/storage/HTTP so two clicks cannot create two keys.
    changePhase("sending"); setLocked(true); setError(undefined);
    const current = ++generation.current;
    let pending = attempt.current;
    try {
      if (pending && (!retryable || !await voiceCallAttemptCanRetry(pending, route))) {
        if (alive.current && current === generation.current) { attempt.current = undefined; setText(""); stopAutomatic(); setBlocked(true); changePhase("paused"); setError("Server identity changed or retry identity could not be confirmed. Review Chat."); }
        return;
      }
      if (!alive.current || current !== generation.current) return;
      if (!pending) {
        const restored = await restoreVoiceCallAttempt(route);
        if (!alive.current || current !== generation.current) return;
        if (restored.notice) { stopAutomatic(); setBlocked(true); setText(""); setNotice(restored.notice); changePhase("paused"); return; }
        pending = await prepareVoiceCallAttempt(route, textRef.current.trim(), () => crypto.randomUUID());
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
      if (timing.current) { timing.current.accepted = performance.now(); publishTiming(); }
      attempt.current = undefined; setRetryable(false); setText("");
      if (response.unavailableRecipients?.length) throw new Error("This Agent is unavailable. Check Chat.");
      setMessageId(response.messageId);
      if (response.message) setTranscript(items => [...items.filter(i => i.id !== response.message!.id), response.message!].slice(-20));
      changePhase(response.recipients[0]?.queued ? "queued" : "waiting");
    } catch (failure) {
      if (!alive.current || generation.current !== current) return;
      stopAutomatic(); changePhase("paused");
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500) setBlocked(true);
      setError(`Could not confirm this turn. Its outcome may be unknown; check Chat. ${failure instanceof Error ? failure.message : ""}`);
    } finally { pending = undefined; }
  };
  // One recognizer session is one turn. Final results are deduplicated by the
  // hook; only a clean onend after speechend (or browser end) may auto-submit.
  useEffect(() => {
    if (!handsFreeRef.current || phaseRef.current !== "capture" || dictation.status !== "stopped") return;
    if (!textRef.current.trim()) {
      stopAutomatic(); changePhase("paused"); setNotice("No finalized speech. Resume the call or type deliberately."); return;
    }
    timing.current = { settled: performance.now() };
    changePhase("review"); void send();
  }, [dictation.status, phase, handsFree]);
  useEffect(() => {
    if ((phase !== "queued" && phase !== "waiting") || !messageId) return;
    let cancelled = false;
    const current = generation.current;
    const valid = () => !cancelled && alive.current && liveRef.current && current === generation.current;
    const fail = (message: string) => { if (valid()) { cancelled = true; stopAutomatic(); changePhase("paused"); setError(message); } };
    const deadline = setTimeout(() => fail("The Agent is still working after 120 seconds. Open Chat for its reply."), 120_000);
    // Reuse the existing authenticated workspace/Agent SSE → Query invalidations.
    // An active, product-specific observer wakes on those same Chat prefixes.
    // ponytail: full authored replies only; 5s reads cover missed/no SSE wakeups.
    const observer = new QueryObserver<ConversationDetailDto>(queryClient, {
      queryKey: [...queryKeys.conversations.detail(conversationId, 20), product, "voice-reply"],
      queryFn: () => {
        // Existing invalidations may cancel a Query promise, but our HTTP API
        // has no abort signal. Share the actual read until it settles.
        if (!replyRead.current) replyRead.current = api.getConversation(conversationId, 20).finally(() => { replyRead.current = undefined; });
        return replyRead.current;
      },
      staleTime: 0, gcTime: 0, retry: false, refetchInterval: 5_000,
      refetchIntervalInBackground: false,
    });
    const observe = (result: ReturnType<typeof observer.getCurrentResult>) => {
      if (!valid()) return;
      if (result.error) { fail(result.error.message); return; }
      // Never speak cached results from before this observer's fresh read.
      if (!result.isSuccess || result.isFetching || !result.isFetchedAfterMount) return;
      const detail = result.data;
      if (!validateDetail(detail)) { suspend(); setError("The call’s Agent or Chat is unavailable."); return; }
      const reply = voiceReplyInWindow(messageId, detail.messages, agentId);
      if (reply) {
        if ("error" in reply) { fail(reply.error); return; }
        cancelled = true; clearTimeout(deadline);
        if (timing.current) { timing.current.reply = performance.now(); publishTiming(); }
        const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId)!;
        const receipt = sent.deliveryReceipts!.find(i => i.targetAgentId === agentId)!;
        const execution = receipt.state === "recovered" ? receipt.recoveryExecutionId : receipt.executionId;
        const answer = detail.messages.find(i => i.conversationId === conversationId && i.role === "assistant" && i.communicationIntent === "user_dm" && i.authorAgentId === agentId && i.executionId === execution)!;
        setTranscript(items => [...items.filter(i => i.id !== sent.id && i.id !== answer.id), sent, answer].slice(-20));
        const spoken = speakableMessageText(reply.text);
        setPlayText(spoken || undefined);
        if (spoken) play(spoken, current); else { stopAutomatic(); changePhase("ready"); setNotice("Read the canonical reply in the transcript or Chat."); }
        return;
      }
      const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId);
      if (sent?.deliveryReceipts?.some(i => i.targetAgentId === agentId && ["started", "delivered", "processed", "recovering", "recovered"].includes(i.state))) changePhase("waiting");
    };
    const unsubscribe = observer.subscribe(observe);
    return () => { cancelled = true; unsubscribe(); observer.destroy(); clearTimeout(deadline); };
  }, [phase === "queued" || phase === "waiting", messageId, conversationId, agentId, ownerId, product, queryClient, changePhase, suspend, stopAutomatic]);
  const recording = ["starting", "listening", "pausing", "stopping"].includes(dictation.status);
  const inFlight = ["sending", "queued", "waiting", "loading", "speaking"].includes(phase);
  const status = phase === "capture" ? dictation.status === "starting" ? "Starting microphone…" : dictation.status === "stopping" ? "Finishing transcript…" : "Listening…"
    : phase === "queued" ? "Queued for the Agent…" : phase === "waiting" ? "Waiting for the Agent… Agent working" : phase === "loading" ? "Loading speech…" : phase === "speaking" ? "Speaking…" : phase === "sending" ? "Sending…" : muted ? "Microphone muted" : phase === "paused" ? "Call paused" : "Microphone off";
  const availableAgents = agents.filter(a => member(a, projectId, conversationId));
  const agentName = availableAgents.find(a => a.id === agentId)?.title ?? "Choose an Agent";
  const cannotStart = !live || !checked || muted || Boolean(sttUnavailable) || recording || inFlight || recovering || Boolean(attempt.current) || blocked || Boolean(text.trim());
  return <Dialog open fullWidth maxWidth="xs" aria-labelledby={`${ownerId}-title`} onClose={end}
    PaperProps={{ sx: { m: { xs: 1, sm: 4 }, width: { xs: "calc(100% - 16px)", sm: "100%" }, borderRadius: 3, maxHeight: "calc(100% - 32px)" } }}
    sx={{ "& .MuiDialog-container": { alignItems: { xs: "flex-end", sm: "center" } } }}>
    <DialogTitle id={`${ownerId}-title`} sx={{ textAlign: "center", pb: 0 }}>{agentName}</DialogTitle>
    <DialogContent ref={mountSurface}><Stack spacing={2} sx={{ pt: 2 }}>
      {!locked && availableAgents.length > 1 && <TextField select SelectProps={{ native: true }} label="Call Agent" value={agentId} disabled={recording || inFlight || Boolean(attempt.current)} onChange={e => setAgentId(e.target.value)}>
        <option value="" disabled>Choose an Agent</option>
        {availableAgents.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
      </TextField>}
      <Box role="status" aria-live="polite" sx={{ textAlign: "center", py: 2 }}>
        <Box aria-hidden sx={{ width: 56, height: 56, borderRadius: "50%", bgcolor: recording || phase === "speaking" ? "primary.main" : "action.hover", color: recording || phase === "speaking" ? "primary.contrastText" : "text.secondary", display: "grid", placeItems: "center", mx: "auto", mb: 1.5 }}><PhoneIcon /></Box>
        <Typography>{phase === "ready" && !muted ? "Ready to call" : status}</Typography>
        {handsFree && <Typography variant="caption" color="text.secondary">Hands-free call active · automatic finalized turns</Typography>}
      </Box>
      {(phase === "ready" || phase === "paused") && !handsFree && <Typography variant="caption" color="text.secondary" sx={{ textAlign: "center" }}>Start call sends each finalized spoken turn automatically as a private message. Browser speech may use the browser vendor’s remote processing.</Typography>}
      {sttUnavailable && <Alert severity="info">{sttUnavailable} Use Chat or expand Transcript &amp; typing.</Alert>}
      {ttsUnavailable && <Alert severity="info">{ttsUnavailable} Read replies in Chat.</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="warning">{error}</Alert>}
      <Stack direction="row" spacing={1} justifyContent="center" sx={{ flexWrap: "wrap", gap: 1, "& button": { minHeight: 48 } }}>
        {(phase === "loading" || phase === "speaking") ? <Button variant="contained" disabled={muted || Boolean(sttUnavailable)} onClick={() => {
          generation.current++;
          if (!stopSpeech(ownerId)) { stopAutomatic(); changePhase("paused"); setError(speechSnapshot().error); return; }
          changePhase("ready"); listenRef.current();
        }}>Talk now</Button> : phase === "paused" ? <Button variant="contained" disabled={recovering || blocked || Boolean(attempt.current)} onClick={() => { void resume(); }}>Resume call</Button>
          : !recording && !inFlight && <Button variant="contained" disabled={cannotStart} onClick={startCall}>Start call</Button>}
        <Button aria-pressed={muted} startIcon={muted ? <MicOffIcon /> : <MicNoneIcon />} onClick={() => { if (!muted) { stopAutomatic(); abandon(); changePhase("paused"); setNotice("Microphone muted. Unfinished words were discarded."); } setMuted(!muted); }}>{muted ? "Unmute microphone" : "Mute microphone"}</Button>
        <Button color="error" startIcon={<CallEndIcon />} onClick={end}>End call</Button>
      </Stack>
      {attempt.current && <Button disabled={!live || !checked || recording || inFlight || recovering || blocked || !retryable} onClick={() => { void send(); }}>Retry same turn</Button>}
      {playText && error && !inFlight && !recording && !ttsUnavailable && !expanded && <Button onClick={() => play(playText)}>Play reply</Button>}
      <Button size="small" sx={{ minHeight: 44 }} aria-expanded={expanded} aria-controls={`${ownerId}-details`} onClick={() => setExpanded(value => !value)}>Transcript &amp; typing</Button>
      {expanded && <Stack id={`${ownerId}-details`} spacing={2}>
        {latency && <Typography aria-label="Call timing" variant="caption">{latency} Recognition finalization and provider time vary; these are this turn’s observed intervals.</Typography>}
        <Box aria-label="Call transcript">{transcript.map(message => <Box key={message.id} sx={{ mb: 1 }}><Typography variant="caption">{message.role === "user" ? "You" : "Agent"}</Typography><Typography sx={{ whiteSpace: "pre-wrap" }}>{message.document ? "Full message available in Chat." : message.text}</Typography></Box>)}</Box>
        <TextField label="Your next turn" multiline minRows={2} value={text} disabled={recording || inFlight || recovering || Boolean(attempt.current) || blocked} onChange={e => setText(e.target.value)} />
        {text.trim() && !recording && !inFlight && <Typography variant="caption">Send or clear your draft before starting a call.</Typography>}
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1, "& button": { minHeight: 48 } }}>
          {(phase === "loading" || phase === "speaking") && <Button onClick={() => { stopAutomatic(); generation.current++; stopSpeech(ownerId); changePhase("ready"); }}>Stop speaking</Button>}
          {playText && !inFlight && !recording && !ttsUnavailable && <Button onClick={() => play(playText)}>Play reply</Button>}
          {recording && <Button disabled={dictation.status === "stopping"} onClick={dictation.stop}>Finish turn</Button>}
          {handsFree && recording && <Button onClick={() => { stopAutomatic(); dictation.abandon(); changePhase("review"); }}>Review / type instead</Button>}
          <Button disabled={!live || !checked || muted || Boolean(sttUnavailable) || recording || inFlight || recovering || Boolean(attempt.current) || blocked} onClick={() => { stopAutomatic(); listen(); }}>Listen</Button>
          <Button disabled={!live || !checked || !text.trim() || recording || inFlight || recovering || blocked || Boolean(attempt.current)} onClick={() => { void send(); }}>Send turn</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">Read and type in Chat anytime. Calls require a visible foreground page. End stops browser audio and discards unsent words; accepted work continues. An unconfirmed send keeps its full private words only in this mounted call for deliberate retry. This tab stores only an identity marker. End, reopening or reload drops the call’s retry payload and requires Chat review; markers cannot reconstruct words. Retry expires after 24 hours, without promising physical browser or network memory erasure.</Typography>
      </Stack>}
    </Stack></DialogContent>
  </Dialog>;
}
