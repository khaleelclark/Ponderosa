import {assistantSubmissionError} from '../chat/composerUtils';
import {createClientId} from '../../clientId';
import PhoneIcon from "@mui/icons-material/Phone";
import CallEndIcon from "@mui/icons-material/CallEnd";
import MicOffIcon from "@mui/icons-material/MicOff";
import NotesRoundedIcon from "@mui/icons-material/NotesRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import MicNoneIcon from "@mui/icons-material/MicNone";
import { Alert, Box, Button, Dialog, DialogContent, Stack, TextField, Typography, useMediaQuery } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type AgentDto, type ConversationDetailDto, type ConversationMessageDto } from "@ponderosa/core";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { productApiPath, currentProductScope } from "../../api/productScope";
import { useWorkspacePreferences } from "../../hooks/queries";
import { queryKeys } from "../../queryKeys";
import { publishConversationMessageReceipt } from "../../conversationMessageReceipt";
import { dictationUnavailableReason, speechSynthesisUnavailableReason } from "./browserSpeech";
import { speechSnapshot, startSpeech, startSpeechQueue, stopSpeech, subscribeSpeech, type SpeechQueue } from "./speechCoordinator";
import { monitorSpeechSurfaceAccessibility, speechSurfaceIsAccessible } from "./speechSurfaceAccessibility";
import { isSpokenEcho, speakableMessageText } from "./speechText";
import { claimPageCapture, ownsPageCapture } from "./captureCoordinator";
import { useDictation } from "./useDictation";
import { VoiceReplyBuffers, voiceTimingText, type VoiceTiming } from "./voiceReplyStream";
import { voiceReplyInWindow } from "./voiceReply";
import { VOICE_ATTEMPT_TTL, prepareVoiceCallAttempt, restoreVoiceCallAttempt, retainVoiceCallAttempt, settleVoiceCallAttempt, voiceCallAttemptCanRetry, type VoiceCallAttempt, type VoiceRoute } from "./voiceCallAttempt";

type Phase = "ready" | "capture" | "review" | "sending" | "queued" | "waiting" | "loading" | "speaking" | "paused";
type CallDraft = {text:string;voice:boolean;settled?:number};
export interface VoiceConversationContext {
  projectId: string; conversationId: string; agents: AgentDto[];
  selectedAgentId?: string; lockAgent?: boolean; standalone?: boolean;
  /** Assistant intake preserves steering and holds native next-Run commands. */
  steeringOnly?: boolean;
  /** Only an explicit handset opening gesture may request initial capture. */
  startOnOpen?: boolean;
  onOpenRecovery?(agentId:string):void;
}
const CALL_RECOVERABLE_ERRORS = ["no-speech", "network"] as const;
const CALL_SILENCE_RETRY_MS = 600;
const CALL_NETWORK_RETRY_DELAYS_MS = [700, 1_400, 3_000] as const;
const member = (agent: AgentDto, projectId: string, conversationId: string) => agent.projectId === projectId && agent.conversationId === conversationId;
export function VoiceConversation(props: VoiceConversationContext & { open: boolean; onClose(): void }): JSX.Element {
  const product = productApiPath("/api/conversations");
  return <>{props.open && <VoiceSession key={JSON.stringify([product, props.projectId, props.conversationId, props.selectedAgentId])} {...props} product={product} />}</>;
}
function VoiceSession({ projectId, conversationId, agents, selectedAgentId, lockAgent, onClose, product, standalone, startOnOpen, steeringOnly=false,onOpenRecovery }: VoiceConversationContext & { onClose(): void; product: string }): JSX.Element {
  const phone = useMediaQuery('(max-width:599.95px)');
  const ownerId = useId();
  const openingCaptureAttempted=useRef(false);
  const root = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);
  const observationCleanup = useRef<() => void>();
  const tombstoned = useRef<number>();
  const alive = useRef(true);
  const captureOwner = useRef({});
  const captureLease = useRef<() => void>();
  const microphone = useRef<MediaStream>();
  const microphoneEpoch = useRef(0);
  const microphoneOpening = useRef(false);
  const [openingMicrophone, setOpeningMicrophone] = useState(false);
  const callInput = useRef({ track: () => microphone.current?.getAudioTracks()[0] });
  const closeMicrophone = useCallback(() => {
    microphoneEpoch.current++; microphoneOpening.current = false;
    const stream = microphone.current; microphone.current = undefined;
    stream?.getTracks().forEach(track => track.stop());
    if (alive.current) setOpeningMicrophone(false);
  }, []);
  const releaseCapture = useCallback(() => {
    closeMicrophone(); captureLease.current?.(); captureLease.current = undefined;
  }, [closeMicrophone]);
  const [agentId, setAgentId] = useState(() => {
    const eligible = agents.filter(a => member(a, projectId, conversationId));
    return selectedAgentId ?? (eligible.length === 1 ? eligible[0]!.id : "");
  });
  const [expanded, setExpanded] = useState(Boolean(standalone && dictationUnavailableReason()));
  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef(phase);
  const changePhase = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);
  const [text, setText] = useState("");
  const textRef = useRef(text); textRef.current = text;
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const resumeCaptureRequested=useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const networkFailures = useRef(0);
  const cancelListenRetry = useCallback(() => {
    if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
  }, []);
  const stopAutomatic = useCallback(() => {
    cancelListenRetry();
    handsFreeRef.current = false;resumeCaptureRequested.current=false;
    setHandsFree(false);
    networkFailures.current = 0;
    dictationRef.current.abandon(); releaseCapture();
  }, [cancelListenRetry, releaseCapture]);
  const listenRef = useRef<() => void>(() => {});
  const timing = useRef<VoiceTiming>();
  const recognitionSettled = useRef<number>();
  const voiceDraft = useRef(false);
  const receiptEligible = useRef(false);
  const receiptForMessage = useRef<string>();
  const receiptQueued = useRef(new Set<string>());
  const replyElement = useRef<HTMLElement | null>(null);
  const [renderReply, setRenderReply] = useState<{ generation: number; inputId: string; runId: string; text: string; canonicalId?: string }>();
  const [latency, setLatency] = useState<string>();
  const replyRead = useRef<Promise<ConversationDetailDto>>();
  const publishTiming = () => {
    const t = timing.current;
    if (t) setLatency(voiceTimingText(t));
  };
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(muted); mutedRef.current = muted;
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
  const [replyPending, setReplyPendingState] = useState(false);
  const replyPendingRef = useRef(false);
  const setReplyPending = (next: boolean) => { replyPendingRef.current = next; setReplyPendingState(next); };
  const [provisionalReply, setProvisionalReply] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");
  const observedRun = useRef<string>();
  const canonicalReplyId = useRef<string>();
  const [delivery,setDelivery]=useState<{messageId:string;receipt:NonNullable<ConversationMessageDto['deliveryReceipts']>[number]}>();
  const [audioPurpose,setAudioPurpose]=useState<"answer"|"acknowledgement"|"receipt">();
  const suppressedAudio = useRef<number>();
  const spokenSpans = useRef<string[]>([]);
  const interruptRef = useRef<() => boolean>(() => true);
  const submissionPending = useRef(false);
  const deliveryBlocked = useRef(false);
  const [replyNeedsReview,setReplyNeedsReview]=useState(false);
  const finishedDrafts = useRef<CallDraft[]>([]);
  const [unsentDrafts,setUnsentDrafts]=useState<CallDraft[]>([]);
  const sendRef = useRef<() => Promise<void>>(async () => {});
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
    if (alive.current && liveRef.current && handsFreeRef.current && !mutedRef.current) {
      voiceDraft.current = true;
      textRef.current = [textRef.current, words].filter(Boolean).join(" "); setText(textRef.current);
    }
  }, () => {}, root, true, () => handsFreeRef.current, callInput.current, CALL_RECOVERABLE_ERRORS, {
    owner:captureOwner.current,
    onStart:()=>{const state=speechSnapshot();if(state.ownerId!==ownerId||!['loading','speaking'].includes(state.status))spokenSpans.current=[];},
    acceptResult:words=>{
      if(!alive.current||!liveRef.current||!handsFreeRef.current||mutedRef.current||!ownsPageCapture(captureOwner.current))return false;
      const audio=speechSnapshot();
      if((audio.ownerId===ownerId&&(audio.status==="speaking"||audio.lastPhraseEndedAt!==undefined&&Date.now()-audio.lastPhraseEndedAt<500))&&isSpokenEcho(words,spokenSpans.current))return false;
      return interruptRef.current();
    },
  });
  const dictationRef = useRef(dictation); dictationRef.current = dictation;
  const abandon = useCallback(() => {
    generation.current++;
    observationCleanup.current?.();
    setReplyPending(false);
    setAcknowledgement("");
    dictationRef.current.abandon();
    stopSpeech(ownerId);
    releaseCapture(); setAudioPurpose(undefined);
  }, [ownerId,releaseCapture]);
  const suspend = useCallback(() => {
    stopAutomatic(); abandon(); voiceDraft.current = false; setText(""); changePhase("paused"); setChecked(false);
    textRef.current='';finishedDrafts.current=[];setUnsentDrafts([]);
    setNotice("Call interrupted. Unsent words were discarded. Accepted work continues in Chat; reconnect when ready.");
  }, [abandon, changePhase, stopAutomatic]);
  const end = () => { stopAutomatic(); alive.current = false; attempt.current = undefined; finishedDrafts.current=[];voiceDraft.current = false; setText(""); abandon(); onClose(); };
  const validateDetail = (detail: ConversationDetailDto) => {
    const chat = detail.conversation;
    return chat.id === conversationId && chat.projectId === projectId &&
      (currentProductScope()==="branches" ? Boolean(chat.branchId) : !chat.branchId) &&
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
  useEffect(() => { alive.current = true; return () => { alive.current = false; attempt.current = undefined; cancelListenRetry(); abandon(); }; }, [abandon, cancelListenRetry]);
  useEffect(() => {
    if (dictation.status === "error") { stopAutomatic(); abandon(); changePhase("paused"); setError(dictation.error); }
    else if (dictation.status === "stopped" && phaseRef.current === "capture" && !handsFreeRef.current) changePhase("review");
  }, [dictation.status, dictation.error, changePhase, stopAutomatic, abandon]);
  useEffect(() => {
    if (!["loading", "speaking"].includes(phaseRef.current)) return;
    if (suppressedAudio.current === generation.current) return;
    if (playback.ownerId !== ownerId) { stopAutomatic(); abandon(); changePhase("ready"); return; }
    if (playback.status === "speaking") changePhase("speaking");
    else if (playback.status === "error" || playback.status === "stopped") {
      stopAutomatic(); abandon(); changePhase("paused"); if (playback.error) setError(`${playback.error} Use Play reply or read the transcript.`);
    }
  }, [playback, ownerId, changePhase, stopAutomatic, abandon]);
  const listen = async () => {
    if (!live || !checked || mutedRef.current || blocked || deliveryBlocked.current || recovering || !handsFreeRef.current || microphoneOpening.current ||
        ['starting','listening','pausing','stopping'].includes(dictationRef.current.status)) return;
    if (!speechSurfaceIsAccessible(root.current)) { suspend(); return; }
    if (!captureLease.current || !ownsPageCapture(captureOwner.current)) captureLease.current=claimPageCapture(suspend,captureOwner.current);
    const epoch=++microphoneEpoch.current;
    microphoneOpening.current=true;setOpeningMicrophone(true);
    try {
      if(!microphone.current?.getAudioTracks().some(track=>track.readyState==='live')){
        if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone capture is unavailable in this browser.');
        const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        if(!alive.current||epoch!==microphoneEpoch.current||mutedRef.current||!handsFreeRef.current||!ownsPageCapture(captureOwner.current)||!speechSurfaceIsAccessible(root.current)){stream.getTracks().forEach(track=>track.stop());return;}
        microphone.current=stream;
      }
      if(epoch!==microphoneEpoch.current||!ownsPageCapture(captureOwner.current))return;
      setLocked(true); setError(undefined); setNotice(undefined);
      if(!replyPendingRef.current&&!submissionPending.current&&!['loading','speaking'].includes(phaseRef.current))changePhase('capture');
      dictationRef.current.start();
    } catch(cause) {
      if(alive.current&&epoch===microphoneEpoch.current){stopAutomatic();abandon();changePhase('paused');setError(cause instanceof Error?cause.message:'Microphone capture failed.');}
    } finally {if(epoch===microphoneEpoch.current){microphoneOpening.current=false;setOpeningMicrophone(false);}}
  };
  listenRef.current = listen;
  const startCall = () => { if (textRef.current.trim()||attempt.current||submissionPending.current) return; handsFreeRef.current = true; setHandsFree(true); void listen(); };
  const resume = async () => {
    const current = ++generation.current;
    try {
      const detail = await api.getConversation(conversationId, 20);
      if (!alive.current || current !== generation.current) return;
      if (!validateDetail(detail)) throw new Error("This Agent or Chat is unavailable.");
      setSurfaceEpoch(value => value + 1); setChecked(true); setError(undefined);
      const hasDraft = Boolean(textRef.current.trim() || attempt.current || finishedDrafts.current.length);
      if (!hasDraft && !sttUnavailable) { resumeCaptureRequested.current=true;handsFreeRef.current = true; setHandsFree(true); }
      changePhase(hasDraft ? "review" : "ready");
    } catch (failure) { if (alive.current && current === generation.current) setError(String(failure)); }
  };
  const visibleReply = () => {
    const node = replyElement.current;
    return Boolean(renderReply && renderReply.generation === generation.current && renderReply.inputId === messageId &&
      renderReply.runId === observedRun.current && node && root.current?.contains(node) &&
      node.textContent === renderReply.text && renderReply.text.trim() && node.getClientRects().length &&
      node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility === "visible" &&
      document.visibilityState === "visible");
  };
  // Layout effects observe committed DOM, not text receipt, compositor paint or heard audio.
  useLayoutEffect(() => {
    const t = timing.current;
    if (t && t.firstAudio === undefined && t.firstCommitted === undefined && visibleReply()) {
      t.firstCommitted = performance.now(); publishTiming();
    }
  }, [expanded, renderReply, messageId]);
  const visibleReplyRef = useRef(visibleReply); visibleReplyRef.current = visibleReply;
  const audioStarted = (current: number) => {
    const t = timing.current;
    if (!alive.current || current !== generation.current || !t || t.firstAudio !== undefined) return;
    t.firstPhraseStart = performance.now();
    t.firstAudio = t.firstPhraseStart;
    // Collapsed text or onset before the commit has no render-to-onset observation.
    if (!visibleReplyRef.current()) t.firstCommitted = undefined;
    publishTiming();
  };
  const play = (spoken: string, current = generation.current) => {
    if (!alive.current || !liveRef.current || current !== generation.current || tombstoned.current === current || phaseRef.current === "capture") return;
    if (ttsUnavailable) { stopAutomatic(); changePhase("ready"); setNotice("Read the reply in Chat, then start the call deliberately."); return; }
    suppressedAudio.current=undefined;setAudioPurpose("answer");
    changePhase("loading");
    startSpeech(ownerId, spoken, preferencesRef.current, () => root.current, () => {
      if (alive.current && current === generation.current) {
        setAudioPurpose(undefined);
        changePhase("ready");
        if (handsFreeRef.current) listenRef.current();
      }
    }, () => {
      spokenSpans.current=[...spokenSpans.current,spoken].slice(-8);setAudioPurpose('answer');
      audioStarted(current);
    },ownsPageCapture(captureOwner.current)?captureOwner.current:undefined);
  };
  const interruptLocalSpeech = () => {
    suppressedAudio.current=generation.current;
    const settled=stopSpeech(ownerId);setAudioPurpose(undefined);
    if(!settled){stopAutomatic();abandon();changePhase("paused");setError(speechSnapshot().error??"Audio cleanup could not be confirmed. Review Transcript before continuing.");return false;}
    return true;
  };
  interruptRef.current=interruptLocalSpeech;
  const send = async () => {
    if (!live || !checked || recovering || blocked || deliveryBlocked.current || submissionPending.current ||
        (!finishedDrafts.current.length&&!attempt.current&&['starting','listening','pausing','stopping'].includes(dictationRef.current.status))) return;
    if (steeringOnly) {
      const admissionError = assistantSubmissionError(attempt.current?.request.text ?? finishedDrafts.current[0]?.text ?? textRef.current.trim(), attempt.current?.request.activeRunDelivery === "queue");
      if (admissionError) {
        stopAutomatic();dictationRef.current.abandon();closeMicrophone();
        textRef.current=[...finishedDrafts.current.map(draft=>draft.text),textRef.current].filter(Boolean).join('\n');setText(textRef.current);finishedDrafts.current=[];setUnsentDrafts([]);
        changePhase("review"); setError(admissionError); return;
      }
    }
    if (attempt.current && Date.now() - attempt.current.marker.createdAt >= VOICE_ATTEMPT_TTL) {
      attempt.current = undefined; stopAutomatic(); setBlocked(true); setError("The unconfirmed turn expired. Review Chat before sending again."); return;
    }
    if (!attempt.current && !finishedDrafts.current.length && !textRef.current.trim()) return;
    if(!interruptLocalSpeech())return;
    let draft:CallDraft|undefined;
    if(!attempt.current){
      draft=finishedDrafts.current.shift();setUnsentDrafts([...finishedDrafts.current]);
      if(!draft){draft={text:textRef.current.trim(),voice:voiceDraft.current,settled:recognitionSettled.current};textRef.current='';setText('');voiceDraft.current=false;}
    }
    if (!attempt.current) { receiptEligible.current = draft!.voice; receiptForMessage.current = undefined; timing.current = { settled: draft!.settled }; recognitionSettled.current = undefined; setLatency(undefined); setAcknowledgement(""); setRenderReply(undefined); setProvisionalReply(""); observedRun.current = undefined; canonicalReplyId.current = undefined; setDelivery(undefined); }
    observationCleanup.current?.();
    setReplyPending(false);setMessageId(undefined);setDelivery(undefined);
    let capturedText=draft?.text;draft=undefined;
    submissionPending.current=true;
    // Set synchronously before hashing/storage/HTTP so two clicks cannot create two keys.
    changePhase("sending"); setLocked(true); setError(undefined);setReplyNeedsReview(false);
    const current = ++generation.current;
    suppressedAudio.current=undefined;
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
        if (restored.notice) { stopAutomatic(); setBlocked(true); setNotice(restored.notice); changePhase("paused"); return; }
        pending = await prepareVoiceCallAttempt(route, capturedText!, () => createClientId());
        if (!alive.current || current !== generation.current) return;
        const stored = retainVoiceCallAttempt(pending);
        attempt.current = pending; setRetryable(true);
        if (!stored) setNotice("Storage is unavailable. Only this mounted call can retry; reload recovery cannot be guaranteed. Review Chat after closing.");
      }
      const marker = pending.marker;
      if (timing.current) timing.current.sentObserved ??= performance.now();
      const responsePromise = api.sendMultiAgentDirectMessage(marker.route.conversationId, pending.request);
      // The in-flight transport owns its bytes; this coroutine retains only the
      // marker. End/unmount releases the mounted retry payload reference.
      pending = undefined;capturedText=undefined;
      const response = await responsePromise;
      // Settlement is independent of the view generation. Never erase another attempt.
      const acceptedVoiceUtterance = receiptEligible.current;
      settleVoiceCallAttempt(marker);
      if (attempt.current?.marker === marker) {
        attempt.current = undefined;
        receiptEligible.current = false;
        if (alive.current) setRetryable(false);
      }
      void publishConversationMessageReceipt(queryClient, marker.route.conversationId, response.message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(marker.route.conversationId) });
      if (!alive.current || generation.current !== current) return;
      if (timing.current) { timing.current.acceptedObserved = performance.now(); timing.current.acceptedAt = response.message?.createdAt; publishTiming(); }
      attempt.current = undefined; setRetryable(false);
      if (response.unavailableRecipients?.length) throw new Error("This Agent is unavailable. Check Chat.");
      const acceptedMessageId = response.message?.communicationEventId ?? response.messageId;
      if (!acceptedMessageId) throw new Error("The accepted message could not be identified. Check Chat.");
      receiptForMessage.current = acceptedVoiceUtterance ? acceptedMessageId : undefined;
      receiptEligible.current = false;
      setMessageId(acceptedMessageId);
      setReplyPending(true);
      if (response.message) setTranscript(items => [...items.filter(i => i.id !== response.message!.id), response.message!].slice(-20));
      changePhase("queued");
    } catch (failure) {
      if (!alive.current || generation.current !== current) return;
      dictationRef.current.abandon();closeMicrophone();
      stopAutomatic(); changePhase("paused");
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500) setBlocked(true);
      setError(`Could not confirm delivery. Your message may have arrived; check Chat before trying again. ${failure instanceof Error ? failure.message : ""}`);
    } finally {
      if(capturedText&&alive.current&&generation.current===current&&!attempt.current){textRef.current=[capturedText,...finishedDrafts.current.map(draft=>draft.text),textRef.current].filter(Boolean).join('\n');setText(textRef.current);finishedDrafts.current=[];setUnsentDrafts([]);}
      pending = undefined;capturedText=undefined;submissionPending.current=false;
      if(alive.current&&handsFreeRef.current&&!mutedRef.current&&finishedDrafts.current.length&&!attempt.current)void sendRef.current();
    }
  };
  sendRef.current=send;
  // A recognizer session may end during silence. Keep the call open and retry
  // after a short delay. Only actual network failures use increasing backoff.
  useEffect(() => {
    if (!handsFreeRef.current || mutedRef.current || dictation.status !== "stopped") {cancelListenRetry();return;}
    if (textRef.current.trim()) {
      if (dictation.endReason !== "natural") {
        stopAutomatic(); changePhase("review");
        setError("Listening stopped before you finished speaking. Review your words, then send or clear the draft.");
        return;
      }
      networkFailures.current = 0; setNotice(undefined);
      recognitionSettled.current = performance.now();
      finishedDrafts.current.push({text:textRef.current.trim(),voice:voiceDraft.current,settled:recognitionSettled.current});setUnsentDrafts([...finishedDrafts.current]);
      textRef.current='';setText('');voiceDraft.current=false;
      // Bound private, not-yet-submitted speech; this is not an accepted-work queue.
      if(finishedDrafts.current.length>=8){stopAutomatic();closeMicrophone();changePhase('review');setNotice('Review Your Unsent Messages in Transcript.');return;}
      if(!submissionPending.current&&!attempt.current)void send();
      listenRef.current();
      return;
    }
    if (dictation.endReason === "network" && ++networkFailures.current >= 4) {
      stopAutomatic(); changePhase("paused");
      setError("The browser speech service could not reconnect. Check your connection, then reconnect the call.");
      return;
    }
    const delay = dictation.endReason === "network"
      ? CALL_NETWORK_RETRY_DELAYS_MS[networkFailures.current - 1]!
      : CALL_SILENCE_RETRY_MS;
    if (dictation.endReason !== "network") networkFailures.current = 0;
    setNotice(undefined);
    cancelListenRetry();
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined;
      if (!alive.current || !handsFreeRef.current ||
          !liveRef.current || !root.current) return;
      if (!speechSurfaceIsAccessible(root.current)) { suspend(); return; }
      listenRef.current();
    }, delay);
  }, [dictation.status, dictation.endReason, handsFree, muted, cancelListenRetry, changePhase, stopAutomatic]);
  useEffect(() => {
    if (!replyPendingRef.current || !messageId) return;
    let cancelled = false;
    const current = generation.current;
    const valid = () => !cancelled && tombstoned.current !== current && alive.current && liveRef.current && current === generation.current;
    let dispose = () => {};
    const fail = (message: string) => { if (valid()) {
      tombstoned.current = current; cancelled = true; setReplyPending(false);setReplyNeedsReview(true); stopSpeech(ownerId); stopAutomatic();
      setAcknowledgement(""); setProvisionalReply(""); setPlayText(undefined); changePhase("paused"); setError(message); dispose();
    } };
    const buffers = new VoiceReplyBuffers();
    const buffer = buffers.answer;
    const queuedPurposes: Array<"answer" | "acknowledgement" | "receipt"> = [];
    let queue: SpeechQueue | undefined;
    let streaming = false;
    let streamFailed = false;
    let statusRead: Promise<boolean> | undefined;
    let exposure: import("@ponderosa/core").VoiceReplyStatus["memoryExposure"];
    let canonicalSeen = false;
    let validationVersion = 0;
    const append = (phrases: string[], purpose: "answer" | "acknowledgement" | "receipt" = "answer") => {
      if (!valid() || !phrases.length || suppressedAudio.current===current) return;
      if (purpose === "answer" && timing.current) { timing.current.firstSpeakable ??= performance.now(); publishTiming(); }
      if (ttsUnavailable) return;
      if (!queue) {
        changePhase("loading");
        queue = startSpeechQueue(ownerId, preferencesRef.current, () => root.current, () => {
          if (!alive.current || current !== generation.current) return;
          dispose();setAudioPurpose(undefined);
          changePhase("ready");
          if (handsFreeRef.current) listenRef.current();
        }, text => {
          if(!valid()||suppressedAudio.current===current)return;
              const purpose = queuedPurposes.shift();
          setAudioPurpose(purpose);spokenSpans.current=[...spokenSpans.current,text].slice(-8);
          if (purpose === "acknowledgement") buffers.acknowledgement.started();
          else if (purpose === "answer") { buffer.started(); audioStarted(current); }
        }, async () => {
          if (!valid()) return false;
          // Receipt speaks only for the accepted input; provider phrases still
          // require their exact Run and memory-exposure gate.
          if (queuedPurposes[0] === "receipt") {
            if (mutedRef.current || phaseRef.current === "capture") return "skip";
            return receiptForMessage.current === messageId;
          }
          const permitted = await refreshStatus();
          if (!valid()) return false;
          if (!permitted) fail("Memory context could not be validated. Check Chat before continuing.");
          return permitted && valid();
        }, () => { queuedPurposes.shift(); },ownsPageCapture(captureOwner.current)?captureOwner.current:undefined);
      }
      for (const phrase of phrases) {
        const queuedAt = performance.now();
        queuedPurposes.push(purpose);
        if (!queue.append(phrase)) { fail(speechSnapshot().error ?? "Browser speech paused. Read the reply in Chat."); break; }
        if (purpose === "answer" && timing.current) { timing.current.firstQueued ??= queuedAt; publishTiming(); }
      }
    };
    const accept = (reply: import("@ponderosa/core").VoiceReplySnapshot) => {
      if (reply.presentation === "text") return;
      if (!valid() || reply.projectId !== projectId || reply.conversationId !== conversationId ||
          reply.agentId !== agentId || reply.messageId !== messageId) return;
      if (observedRun.current && observedRun.current !== reply.runId) { fail("The reply changed while this call was open. Check Chat before continuing."); return; }
      observedRun.current = reply.runId;
      if (reply.publication && (reply.publication.kind !== "message" || reply.publication.intent !== "direct_to_user" || reply.publication.recipientAgentIds?.length)) return;
      const isAcknowledgement = reply.purpose === "acknowledgement";
      if (!isAcknowledgement && timing.current) {
        Object.assign(timing.current, { acceptedAt: reply.acceptedAt, leasedAt: reply.leasedAt,
          runStartedAt: reply.runStartedAt, submittedAt: reply.submittedAt, firstModelTextAt: reply.firstModelTextAt, firstTextAt: reply.firstTextAt ?? timing.current.firstTextAt, completedAt: reply.completedAt ?? timing.current.completedAt });
        if (reply.text && reply.state !== "failed" && !streamFailed) timing.current.firstReceived ??= performance.now();
        publishTiming();
      }
      if (reply.failureReason === "context_changed") {
        setProvisionalReply(""); setRenderReply(undefined); setPlayText(undefined);
        fail("The reply context changed. Check Chat before continuing."); return;
      }
      if (reply.state === "failed") {
        // This intentional queue stop still awaits the exact canonical fallback.
        changePhase("waiting");
        streamFailed = true; queue?.stop(); queue = undefined; queuedPurposes.length = 0; buffer.discardQueued(); streaming = false; stopAutomatic();
        setNotice("The live reply stopped updating. Check the reply in Chat."); return;
      }
      if (streamFailed) return;
      if (isAcknowledgement) {
        if (receiptQueued.current.has(messageId)) return;
        try {
          const accepted = buffers.accept(reply);
          if (accepted.phrases.length) { setAcknowledgement(reply.text); append(accepted.phrases, accepted.purpose); }
        } catch (error) { fail((error as Error).message); }
        return;
      }
      setRenderReply({ generation: current, inputId: messageId, runId: reply.runId, text: reply.text });
      setDelivery(undefined);
      setProvisionalReply(reply.text);
      streaming = reply.state === "streaming";
      try { append(buffers.accept(reply).phrases); } catch (error) { fail((error as Error).message); }
    };
    const refreshStatus = (): Promise<boolean> => {
      if (!valid()) return Promise.resolve(false);
      if (statusRead) return statusRead;
      const version = validationVersion;
      const request = api.getVoiceReplyStatus(conversationId, messageId, agentId).then(status => {
        if (!valid() || status.messageId !== messageId || version !== validationVersion) return false;
        if (status.canonicalReplyEventId && canonicalReplyId.current!==status.canonicalReplyEventId) {
          canonicalReplyId.current=status.canonicalReplyEventId;
          void queryClient.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(conversationId)});
        }
        if (timing.current) {
          Object.assign(timing.current, { acceptedAt: status.acceptedAt, leasedAt: status.leasedAt, runStartedAt: status.runStartedAt,
            submittedAt: status.reply?.purpose === "acknowledgement" ? timing.current.submittedAt : status.reply?.submittedAt ?? timing.current.submittedAt, firstModelTextAt: status.reply?.purpose === "acknowledgement" ? timing.current.firstModelTextAt : status.reply?.firstModelTextAt ?? timing.current.firstModelTextAt,
            firstTextAt: status.reply?.purpose === "acknowledgement" ? timing.current.firstTextAt : status.reply?.firstTextAt ?? timing.current.firstTextAt, completedAt: status.reply?.purpose === "acknowledgement" ? timing.current.completedAt : status.reply?.completedAt ?? timing.current.completedAt });
          publishTiming();
        }
        // A canonical read may settle before this finite status request. Its
        // exact timing can still arrive; it must never reopen playback.
        if (!valid()) return false;
        if (status.runId && observedRun.current && status.runId !== observedRun.current) { fail("The reply changed while this call was open. Check Chat before continuing."); return false; }
        if (status.runId) observedRun.current = status.runId;
        if (["failed", "cancelled", "outcome_unknown"].includes(status.runStatus ?? "")) { fail("The reply stopped. Check Chat before continuing."); return false; }
        const next = status.memoryExposure;
        if (!next || next.state === "invalid" || (next.runId && next.runId !== observedRun.current)) {
          fail("Memory or session changed during this reply. Check Chat before continuing."); return false;
        }
        if (exposure && ["valid", "disabled"].includes(exposure.state) && (next.state !== exposure.state || next.sessionResetSeq !== exposure.sessionResetSeq || next.projectGeneration !== exposure.projectGeneration || next.globalGeneration !== exposure.globalGeneration)) {
          fail("Memory context changed during this reply. Check Chat before continuing."); return false;
        }
        exposure = next;
        if (status.reply && !canonicalSeen) accept(status.reply);
        return valid() && ["disabled", "valid"].includes(next.state);
      }).catch(() => { fail("Memory context validation is unavailable. Check Chat before continuing."); return false; }).finally(() => { statusRead = undefined; });
      // A hint arriving during an older HTTP read requires a fresh read. Never
      // let the older response authorize speech after the hint.
      statusRead = request.then(permitted => valid() && version !== validationVersion ? refreshStatus() : permitted);
      return statusRead;
    };
    if (receiptForMessage.current === messageId && !receiptQueued.current.has(messageId) &&
        !mutedRef.current && phaseRef.current !== "capture" && !ttsUnavailable) {
      receiptQueued.current.add(messageId);
      append(["Got your message."], "receipt");
    }
    const stream = api.subscribeAgent(agentId, undefined, {
      onOpen: refreshStatus, onStatus: () => refreshStatus(),
      onEvent: envelope => {
        if (!valid() || envelope.agentId !== agentId) return;
        const event = envelope.event;
        if (event.type === "memory_changed" && event.projectId === projectId) {
          if (event.runId === observedRun.current && event.conversationId === conversationId) fail("The reply context changed. Check Chat before continuing.");
          else { validationVersion++; void refreshStatus(); }
        } else if (event.type === "session_reset") {
          if (exposure?.sessionResetSeq !== undefined && envelope.seq > exposure.sessionResetSeq) fail("The session changed during this reply. Check Chat before continuing.");
          else if (exposure?.sessionResetSeq === undefined) { validationVersion++; void refreshStatus(); }
        }
        else if (event.type === "voice_reply" && !canonicalSeen) accept(event.reply);
        else if (event.type === "agent_lifecycle" && event.executionId === observedRun.current &&
            ["cancelled", "failed"].includes(event.status)) fail("The reply stopped. Check Chat before continuing.");
      },
    });
    refreshStatus();
    const phraseTimer = setInterval(() => { if (valid() && streaming) { try { append(buffer.flush()); } catch (error) { fail((error as Error).message); } } }, 100);
    // Nominal backstop only: network/event-loop delay is unbounded; no physical-onset atomicity.
    const exposureTimer = setInterval(() => { const audio=speechSnapshot();if(audio.ownerId===ownerId&&['loading','speaking'].includes(audio.status))void refreshStatus(); }, 250);
    // Reuse the existing authenticated workspace/Agent SSE → Query invalidations.
    // An active, product-specific observer wakes on those same Chat prefixes.
    // Canonical publication still settles the turn; 5s reads cover missed SSE wakeups.
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
      if (!valid() || canonicalSeen) return;
      if (result.error) { fail(result.error.message); return; }
      // Never speak cached results from before this observer's fresh read.
      if (!result.isSuccess || result.isFetching || !result.isFetchedAfterMount) return;
      const detail = result.data;
      refreshStatus();
      if (!validateDetail(detail)) { suspend(); setError("The call’s Agent or Chat is unavailable."); return; }
      const reply = voiceReplyInWindow(messageId, detail.messages, agentId, canonicalReplyId.current);
      if (reply) {
        if ("error" in reply) { fail(reply.error); return; }
        const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId)!;
        const receipt = sent.deliveryReceipts!.find(i => i.targetAgentId === agentId)!;
        const execution = receipt.state === "recovered" ? receipt.recoveryExecutionId : receipt.executionId;
        if (observedRun.current && observedRun.current !== execution) { fail("The reply changed while this call was open. Check Chat before continuing."); return; }
        observedRun.current = execution;
        const answer = detail.messages.find(i => (!canonicalReplyId.current || i.id===canonicalReplyId.current || i.communicationEventId===canonicalReplyId.current) && i.conversationId === conversationId && i.role === "assistant" && i.communicationIntent === "user_dm" && i.authorAgentId === agentId && i.executionId === execution)!;
        setTranscript(items => [...items.filter(i => i.id !== sent.id && i.id !== answer.id), sent, answer].slice(-20));
        const spoken = speakableMessageText(reply.text);
        setPlayText(spoken || undefined); setProvisionalReply("");
        setRenderReply({ generation: current, inputId: messageId, runId: execution!, text: answer.text, canonicalId: answer.id });
        if (timing.current) { timing.current.completedAt = answer.createdAt; timing.current.firstReceived ??= performance.now(); publishTiming(); }
        canonicalSeen = true;
        try {
          const tail = buffer.finish(reply.text);
          append(tail);
          if (cancelled) {
            changePhase("ready");
            setError(`${speechSnapshot().error ?? "Browser speech paused."} Use Play reply or read the transcript.`);
            return;
          }
          setReplyPending(false);
          setDelivery(undefined);deliveryBlocked.current=false;
          if (queue && suppressedAudio.current!==current) queue.finish();
          else { dispose(); changePhase("ready"); if(suppressedAudio.current!==current){stopAutomatic();setNotice("Read the final reply in the transcript or Chat.");} }
        } catch (error) { fail((error as Error).message); return; }
        setReplyPending(false);
        return;
      }
      const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId);
      const receipt=sent?.deliveryReceipts?.find(i=>i.targetAgentId===agentId);
      setDelivery(receipt?{messageId,receipt}:undefined);
      const needsAction=Boolean(receipt&&(receipt.contextRecoveryRequired||receipt.settingsTransitionHold||receipt.contextRolloverHold||receipt.taskDecisionRepairHold||['unconfirmed','waiting_for_run','run_unconfirmed','retry_exhausted','undelivered','failed'].includes(receipt.state)));
      if(needsAction&&!deliveryBlocked.current){deliveryBlocked.current=true;stopAutomatic();dictationRef.current.abandon();closeMicrophone();}
      else if(!needsAction)deliveryBlocked.current=false;
      if (!queue && sent?.deliveryReceipts?.some(i => i.targetAgentId === agentId && ["started", "delivered", "processed", "recovering", "recovered"].includes(i.state))) changePhase("waiting");
    };
    const unsubscribe = observer.subscribe(observe);
    dispose = () => {
      cancelled = true; stream.close(); clearInterval(phraseTimer); clearInterval(exposureTimer); unsubscribe(); observer.destroy();
      if (observationCleanup.current === dispose) observationCleanup.current = undefined;
    };
    observationCleanup.current = dispose;
    return dispose;
  }, [ messageId, conversationId, agentId, ownerId, product, queryClient, changePhase, suspend, stopAutomatic]);
  useEffect(() => {
    if (!startOnOpen || openingCaptureAttempted.current || !alive.current || !root.current?.isConnected ||
        !live || !checked || recovering || blocked || attempt.current || sttUnavailable ||
        phase !== "ready" || muted || document.visibilityState === "hidden") return;
    openingCaptureAttempted.current=true;
    startCall();
  }, [startOnOpen, live, checked, recovering, blocked, sttUnavailable, phase, muted, surfaceEpoch]);
  useEffect(() => {
    // Only a deliberate Reconnect waits for its fresh eligibility render.
    // Automatic utterance/silence cycles restart through their own native end.
    if(resumeCaptureRequested.current&&checked&&!muted&&handsFree&&phase==='ready'&&
       !textRef.current.trim()&&!finishedDrafts.current.length&&!submissionPending.current&&!attempt.current){
      resumeCaptureRequested.current=false;listenRef.current();
    }
  }, [checked,muted,handsFree,phase]);
  const recording = openingMicrophone || ["starting", "listening", "pausing", "stopping"].includes(dictation.status);
  const inFlight = replyPending || ["sending", "queued", "waiting", "loading", "speaking"].includes(phase);
  const currentReceipt=delivery&&delivery.messageId===messageId?delivery.receipt:undefined;
  const hasAnswer=Boolean(renderReply&&renderReply.inputId===messageId&&renderReply.canonicalId&&renderReply.text.trim());
  const needsRecovery=!hasAnswer&&Boolean(currentReceipt?.contextRecoveryRequired||currentReceipt?.settingsTransitionHold||currentReceipt?.contextRolloverHold||currentReceipt?.taskDecisionRepairHold);
  const needsReview=!hasAnswer&&Boolean(currentReceipt&&['unconfirmed','waiting_for_run','run_unconfirmed','retry_exhausted','undelivered','failed'].includes(currentReceipt.state));
  const speaking=playback.ownerId===ownerId&&playback.status==='speaking'&&suppressedAudio.current!==generation.current;
  const status = phase==='paused'?'Call Interrupted':needsRecovery?'Session Needs Recovery':needsReview?'Message Needs Review'
    : text.trim()&&recording?'Listening to You':speaking?audioPurpose==='receipt'?'Message Received':audioPurpose==='acknowledgement'?'Acknowledging Your Message':audioPurpose==='answer'?'Speaking to You':'Preparing Audio'
    : submissionPending.current?'Sending Your Message':replyPending?'Waiting for a Reply':muted?'Microphone Muted'
    : openingMicrophone||dictation.status==='starting'?'Opening Microphone':recording?dictation.status==='stopping'?'Finishing Your Words':'Listening to You'
    : unsentDrafts.length||text.trim()?'Ready to Send':handsFree?'Listening Again Shortly':'Ready When You Are';
  const availableAgents = agents.filter(a => member(a, projectId, conversationId));
  const agentName = availableAgents.find(a => a.id === agentId)?.title ?? "Choose an Agent";
  const initials=agentName.split(/\s+/u).filter(Boolean).slice(0,2).map(word=>word[0]).join("").toLocaleUpperCase();
  const cannotStart = !live || !checked || muted || Boolean(sttUnavailable) || recording || inFlight || recovering || Boolean(attempt.current) || blocked || Boolean(text.trim());
  const toggleMute = () => {
    mutedRef.current = !muted;
    if(!muted) cancelListenRetry();
    if(!muted){dictation.abandon();closeMicrophone();voiceDraft.current = false;textRef.current='';setText('');}
    setMuted(value=>!value);
    if(muted){if(handsFreeRef.current&&finishedDrafts.current.length&&!attempt.current&&!submissionPending.current)void sendRef.current();void listen();}
  };
  const permissionError = error?.startsWith("Microphone permission was denied.");
  const showCallControl = phase === "paused" || (!handsFree && !recording && !text.trim()&&!unsentDrafts.length);
  const roundControl={minWidth:64,width:64,height:64,borderRadius:"50%",p:0,transition:"background-color 180ms ease, transform 180ms ease", "& svg":{fontSize:27}, "&:active":{transform:"scale(.95)"}, "@media (prefers-reduced-motion: reduce)":{transition:"none"}};
  return <Dialog data-ponderosa-call open disableRestoreFocus fullWidth fullScreen={phone} maxWidth="sm" aria-labelledby={`${ownerId}-title`} onClose={end}
    PaperProps={{sx:{m:{xs:0,sm:3},width:{xs:"100%",sm:480},height:{xs:"100%",sm:"min(780px, calc(100dvh - 48px))"},maxHeight:{xs:"100%",sm:"calc(100dvh - 48px)"},borderRadius:{xs:0,sm:6},overflow:"hidden",backgroundImage:"none",bgcolor:"background.default",boxShadow:{sm:"0 28px 100px rgba(18,28,22,.2)"}}}}
    sx={{"& .MuiDialog-container":{alignItems:"center"}}}>
    <DialogContent ref={mountSurface} sx={{p:0,display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{px:3,pt:"max(24px, env(safe-area-inset-top))",pb:1,flexShrink:0,flexWrap:"wrap",gap:1}}>
        <Stack direction="row" spacing={1} alignItems="center"><PhoneIcon sx={{fontSize:16,color:"text.secondary"}}/><Typography variant="caption" color="text.secondary" sx={{fontWeight:600,letterSpacing:".04em"}}>Call</Typography></Stack>
        <Button size="small" aria-label="Transcript" aria-expanded={expanded} aria-controls={`${ownerId}-details`} onClick={()=>setExpanded(value=>!value)} sx={{minHeight:44,minWidth:44,maxWidth:"100%",flexWrap:"wrap",borderRadius:3,color:expanded?"primary.main":"text.secondary"}}><NotesRoundedIcon/><Box component="span" sx={{ml:.75}}>Transcript</Box></Button>
      </Stack>
      <Box sx={{flex:1,minHeight:0,overflowY:"auto",px:{xs:3,sm:4},display:"flex",flexDirection:"column"}}>
        <Stack alignItems="center" sx={{pt:expanded?2:{xs:5,sm:5},pb:3,transition:"padding 180ms ease","@media (prefers-reduced-motion: reduce)":{transition:"none"}}}>
          <Box aria-hidden sx={{width:expanded?88:128,height:expanded?88:128,borderRadius:"50%",display:"grid",placeItems:"center",bgcolor:"primary.main",color:"primary.contrastText",fontSize:expanded?30:44,fontWeight:600,letterSpacing:"-.04em",boxShadow:"0 12px 40px rgba(24,55,41,.10)",mb:3,transition:"width 180ms ease, height 180ms ease","@media (prefers-reduced-motion: reduce)":{transition:"none"}}}>{initials}</Box>
          <Typography id={`${ownerId}-title`} component="h1" sx={{fontSize:{xs:30,sm:32},fontWeight:600,letterSpacing:"-.04em",textAlign:"center",lineHeight:1.2}}>{agentName}</Typography>
          <Box role="status" aria-live="polite" sx={{display:"flex",alignItems:"center",gap:1,mt:1.5,color:"text.secondary",textAlign:"center"}}>
            {recording && !muted && <Box aria-hidden sx={{width:7,height:7,borderRadius:"50%",bgcolor:"success.main"}}/>}<Typography sx={{fontSize:15}}>{recovering?"Checking Your Chat":status}</Typography>
          </Box>
          {handsFree && !error && <Typography variant="caption" color="text.secondary" sx={{mt:1}}>Speak naturally. Your message sends when you finish speaking.</Typography>}
        </Stack>
        {!locked && availableAgents.length>1 && <TextField select SelectProps={{native:true}} label="Call Agent" value={agentId} disabled={recording||inFlight||Boolean(attempt.current)} onChange={e=>setAgentId(e.target.value)} sx={{mb:2}}>
          <option value="" disabled>Choose an Agent</option>{availableAgents.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}
        </TextField>}
        <Stack spacing={1} sx={{mb:2,"& .MuiAlert-root":{borderRadius:3,fontSize:13}}}>
          {sttUnavailable && <Alert severity="info">{sttUnavailable} Type a message in Transcript.</Alert>}
          {ttsUnavailable && <Alert severity="info">{ttsUnavailable} Replies remain in Chat.</Alert>}
          {(needsRecovery||needsReview||replyNeedsReview)&&<Button onClick={()=>{end();onOpenRecovery?.(agentId);}} sx={{minHeight:44}}>Review Recovery in Chat</Button>}
          {currentReceipt&&(needsRecovery||needsReview)&&<Box component="details"><Box component="summary" sx={{minHeight:44,cursor:'pointer',alignContent:'center'}}>Delivery Details</Box><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(currentReceipt,null,2)}</Typography></Box>}
          {notice && <Alert severity="info">{notice}</Alert>}
          {error && <Alert severity="warning">{permissionError ? <>
            Microphone access denied. Allow access in browser settings, then reconnect.
            <Typography component="p" variant="inherit" sx={{mt:1}}>Some speech may be missing. Review Transcript before sending.</Typography>
            <Box component="details"><Box component="summary" sx={{cursor:"pointer",minHeight:44,display:"flex",alignItems:"center"}}>Details</Box><Typography variant="inherit" sx={{overflowWrap:"anywhere"}}>{error}</Typography></Box>
          </> : error}</Alert>}
        </Stack>
        {text.trim() && !expanded && <Box sx={{p:2.5,borderRadius:4,bgcolor:"background.paper",mb:2}}><Typography variant="caption" color="text.secondary">{recording?"Your words":"Review your message"}</Typography><Typography sx={{mt:.5,whiteSpace:"pre-wrap",maxHeight:140,overflowY:"auto",fontSize:16,lineHeight:1.5}}>{text}</Typography></Box>}
        {acknowledgement && !expanded && <Typography aria-label="Agent Acknowledgement" sx={{textAlign:"center",fontSize:16,lineHeight:1.6,mb:2}}>{acknowledgement}</Typography>}
        {expanded && <Stack id={`${ownerId}-details`} spacing={2} sx={{pb:2}}>
          {provisionalReply && <Box sx={{p:2,borderRadius:3,bgcolor:"background.paper"}}><Typography variant="caption" color="text.secondary">Replying</Typography><Typography ref={replyElement} aria-label="Streaming Reply" sx={{whiteSpace:"pre-wrap",mt:.5,lineHeight:1.6}}>{provisionalReply}</Typography></Box>}
          <Stack aria-label="Call Transcript" spacing={1.5}>{transcript.map(message=><Box key={message.id} sx={{p:2,borderRadius:3,bgcolor:message.role==="user"?"action.hover":"background.paper",ml:message.role==="user"?3:0,mr:message.role==="user"?0:3}}><Typography variant="caption" color="text.secondary">{message.role==="user"?"You":agentName}</Typography><Typography ref={renderReply?.canonicalId===message.id?replyElement:undefined} sx={{whiteSpace:"pre-wrap",mt:.5,lineHeight:1.6}}>{message.document?"Full reply available in Chat.":message.text}</Typography></Box>)}</Stack>
          {unsentDrafts.map((draft,index)=><Box key={index} sx={{p:2,borderRadius:3,bgcolor:'background.paper'}}><Typography variant="caption">Unsent Message</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{draft.text}</Typography></Box>)}
          <TextField label="Type A Message" InputLabelProps={{shrink:true}} multiline minRows={2} value={text} disabled={recording||submissionPending.current||recovering||Boolean(attempt.current)||blocked} onChange={e=>{textRef.current=e.target.value;setText(e.target.value);}} sx={{"& .MuiOutlinedInput-root":{borderRadius:3}}}/>
          <Stack direction="row" spacing={1} sx={{flexWrap:"wrap",gap:1,"& button":{minHeight:44}}}>
            {recording && <Button disabled={dictation.status==="stopping"} onClick={dictation.stop}>Done Speaking</Button>}
            {(text.trim()||unsentDrafts.length>0)&&!recording && <Button startIcon={<SendRoundedIcon/>} disabled={!live||!checked||submissionPending.current||recovering||blocked||Boolean(attempt.current)} onClick={()=>{void send();}}>Send</Button>}
            {text.trim()&&!recording&&!inFlight && <Button disabled={Boolean(attempt.current)||blocked} onClick={()=>{voiceDraft.current=false;setText("");}}>Clear Draft</Button>}
            {handsFree&&recording&&<Button onClick={()=>{stopAutomatic();dictation.abandon();changePhase("review");}}>Review Before Sending</Button>}
            {(phase==="loading"||phase==="speaking")&&<Button onClick={interruptLocalSpeech}>Stop Speaking</Button>}
            {playText&&!inFlight&&!recording&&!ttsUnavailable&&<Button onClick={()=>play(playText)}>Play Reply</Button>}
            {replyPending&&observedRun.current&&<Button color="error" onClick={async()=>{const targetRunId=observedRun.current;if(!targetRunId)return;stopAutomatic();abandon();changePhase("paused");try{await api.cancelRun(agentId,{targetRunId,idempotencyKey:createClientId()});setNotice("Reply cancelled. Reconnect when ready.");}catch{setError("Cancellation could not be confirmed. Check Chat; audio is stopped.");}}}>Cancel Reply</Button>}
          </Stack>
          {latency&&<Box component="details"><Box component="summary" sx={{cursor:"pointer",minHeight:44,display:"flex",alignItems:"center",fontSize:12,color:"text.secondary"}}>Call timing</Box><Typography aria-label="Call Timing" variant="caption">{latency}</Typography></Box>}
        </Stack>}
        <Box sx={{flex:1}}/>
        {attempt.current&&!submissionPending.current&&<Stack alignItems="center" spacing={1} sx={{pb:2}}><Typography variant="caption" color="text.secondary">Delivery is unconfirmed. Retry uses the same message to avoid duplicates.</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:140,overflowY:'auto'}}>{attempt.current.request.text}</Typography><Button variant="outlined" disabled={!live||!checked||recording||recovering||blocked||!retryable} onClick={()=>{void send();}} sx={{minHeight:44,borderRadius:8}}>Retry Sending</Button></Stack>}
        {!recording&&!inFlight&&phase!=="paused"&&!text.trim()&&!attempt.current&&!handsFree&&<Typography variant="caption" color="text.secondary" sx={{textAlign:"center",pb:2}}>Browser speech may use remote processing.</Typography>}
      </Box>
      <Box sx={{flexShrink:0,px:3,pt:2,pb:"max(24px, env(safe-area-inset-bottom))",borderTop:"1px solid",borderColor:"divider",bgcolor:"background.paper"}}>
        <Stack direction="row" justifyContent="center" alignItems="flex-start" sx={{flexWrap:"wrap",gap:3}}>
          <Stack spacing={1} alignItems="center"><Button aria-label={muted?"Unmute Microphone":"Mute Microphone"} aria-pressed={muted} disabled={Boolean(sttUnavailable)||(!handsFree&&!recording&&!muted)} onClick={toggleMute} sx={{...roundControl,bgcolor:muted?"text.primary":"action.hover",color:muted?"background.paper":"text.primary","&:hover":{bgcolor:muted?"text.secondary":"action.selected"}}}>{muted?<MicOffIcon/>:<MicNoneIcon/>}</Button><Typography variant="caption" color="text.secondary">{muted?"Unmute":"Mute"}</Typography></Stack>
          {showCallControl && <Stack spacing={1} alignItems="center">
            {phase==="paused"?<Button aria-label="Reconnect Call" disabled={recovering||blocked} onClick={()=>{void resume();}} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><PhoneIcon/></Button>
              :<Button aria-label={handsFree?"Listen":"Start Call"} disabled={cannotStart} onClick={startCall} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><PhoneIcon/></Button>}
            <Typography variant="caption" color="text.secondary">{phase==="paused"?"Reconnect":handsFree?"Listen":"Call"}</Typography>
          </Stack>}
          <Stack spacing={1} alignItems="center"><Button aria-label="End Call" onClick={end} sx={{...roundControl,bgcolor:"error.main",color:"error.contrastText","&:hover":{bgcolor:"error.dark"}}}><CallEndIcon/></Button><Typography variant="caption" color="text.secondary">End</Typography></Stack>
        </Stack>
      </Box>
    </DialogContent>
  </Dialog>;
}
