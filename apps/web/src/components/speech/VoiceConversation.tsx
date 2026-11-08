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
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";
import { speakableMessageText } from "./speechText";
import { useDictation } from "./useDictation";
import { VoiceReplyBuffers, voiceTimingText, type VoiceTiming } from "./voiceReplyStream";
import { voiceReplyInWindow } from "./voiceReply";
import { VOICE_ATTEMPT_TTL, prepareVoiceCallAttempt, restoreVoiceCallAttempt, retainVoiceCallAttempt, settleVoiceCallAttempt, voiceCallAttemptCanRetry, type VoiceCallAttempt, type VoiceRoute } from "./voiceCallAttempt";

type Phase = "ready" | "capture" | "review" | "sending" | "queued" | "waiting" | "loading" | "speaking" | "paused";
export interface VoiceConversationContext {
  projectId: string; conversationId: string; agents: AgentDto[];
  selectedAgentId?: string; lockAgent?: boolean; standalone?: boolean;
}
const member = (agent: AgentDto, projectId: string, conversationId: string) => agent.projectId === projectId && agent.conversationId === conversationId;
export function VoiceConversation(props: VoiceConversationContext & { open: boolean; onClose(): void }): JSX.Element {
  const product = productApiPath("/api/conversations");
  return <>{props.open && <VoiceSession key={JSON.stringify([product, props.projectId, props.conversationId, props.selectedAgentId])} {...props} product={product} />}</>;
}
function VoiceSession({ projectId, conversationId, agents, selectedAgentId, lockAgent, onClose, product, standalone }: VoiceConversationContext & { onClose(): void; product: string }): JSX.Element {
  const phone = useMediaQuery('(max-width:599.95px)');
  const ownerId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);
  const observationCleanup = useRef<() => void>();
  const tombstoned = useRef<number>();
  const alive = useRef(true);
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
  const stopAutomatic = useCallback(() => { handsFreeRef.current = false; setHandsFree(false); }, []);
  const listenRef = useRef<() => void>(() => {});
  const timing = useRef<VoiceTiming>();
  const recognitionSettled = useRef<number>();
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
  const [deliveryNotice,setDeliveryNotice]=useState<string>();
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
    observationCleanup.current?.();
    setReplyPending(false);
    setAcknowledgement("");
    dictationRef.current.abandon();
    stopSpeech(ownerId);
  }, [ownerId]);
  const suspend = useCallback(() => {
    stopAutomatic(); abandon(); changePhase("paused"); setChecked(false);
    setNotice("Call interrupted. Unfinished words were discarded. Accepted work continues in Chat; reconnect when ready.");
  }, [abandon, changePhase, stopAutomatic]);
  const end = () => { stopAutomatic(); alive.current = false; attempt.current = undefined; setText(""); abandon(); onClose(); };
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
  useEffect(() => { alive.current = true; return () => { alive.current = false; attempt.current = undefined; abandon(); }; }, [abandon]);
  useEffect(() => {
    if (dictation.status === "error") { stopAutomatic(); changePhase("paused"); setError(dictation.error); }
    else if (dictation.status === "stopped" && phaseRef.current === "capture" && !handsFreeRef.current) changePhase("review");
  }, [dictation.status, dictation.error, changePhase, stopAutomatic]);
  useEffect(() => {
    if (!["loading", "speaking"].includes(phaseRef.current)) return;
    if (playback.ownerId !== ownerId) { stopAutomatic(); abandon(); changePhase("ready"); return; }
    if (playback.status === "speaking") changePhase("speaking");
    else if (playback.status === "error" || playback.status === "stopped") {
      stopAutomatic(); abandon(); changePhase("ready"); if (playback.error) setError(`${playback.error} Use Play reply or read the transcript.`);
    }
  }, [playback, ownerId, changePhase, stopAutomatic, abandon]);
  const listen = () => {
    if (!live || !checked || muted || blocked || recovering || replyPendingRef.current || attempt.current || phaseRef.current === "capture") return;
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
    changePhase("loading");
    startSpeech(ownerId, spoken, preferencesRef.current, () => root.current, () => {
      if (alive.current && current === generation.current) {
        changePhase("ready");
        if (handsFreeRef.current) listenRef.current();
      }
    }, () => {
      audioStarted(current);
    });
  };
  const send = async () => {
    if (!live || !checked || recovering || blocked || replyPendingRef.current || ["sending", "queued", "waiting", "loading", "speaking", "capture"].includes(phaseRef.current)) return;
    if (attempt.current && Date.now() - attempt.current.marker.createdAt >= VOICE_ATTEMPT_TTL) {
      attempt.current = undefined; setText(""); stopAutomatic(); setBlocked(true); setError("The unconfirmed turn expired. Review Chat before sending again."); return;
    }
    if (!attempt.current && !textRef.current.trim()) return;
    if (!attempt.current) { timing.current = { settled: recognitionSettled.current }; recognitionSettled.current = undefined; setLatency(undefined); setAcknowledgement(""); setRenderReply(undefined); setProvisionalReply(""); observedRun.current = undefined; canonicalReplyId.current = undefined; setDeliveryNotice(undefined); }
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
        pending = await prepareVoiceCallAttempt(route, textRef.current.trim(), () => createClientId());
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
      pending = undefined;
      const response = await responsePromise;
      // Settlement is independent of the view generation. Never erase another attempt.
      settleVoiceCallAttempt(marker);
      void publishConversationMessageReceipt(queryClient, marker.route.conversationId, response.message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(marker.route.conversationId) });
      if (!alive.current || generation.current !== current) return;
      if (timing.current) { timing.current.acceptedObserved = performance.now(); timing.current.acceptedAt = response.message?.createdAt; publishTiming(); }
      attempt.current = undefined; setRetryable(false); setText("");
      if (response.unavailableRecipients?.length) throw new Error("This Agent is unavailable. Check Chat.");
      setMessageId(response.message?.communicationEventId ?? response.messageId);
      setReplyPending(true);
      if (response.message) setTranscript(items => [...items.filter(i => i.id !== response.message!.id), response.message!].slice(-20));
      changePhase("queued");
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
      stopAutomatic(); changePhase("paused"); setNotice("No speech was finalized. Tap Call again or type a turn."); return;
    }
    recognitionSettled.current = performance.now();
    changePhase("review"); void send();
  }, [dictation.status, phase, handsFree]);
  useEffect(() => {
    if (!replyPendingRef.current || !messageId) return;
    let cancelled = false;
    const current = generation.current;
    const valid = () => !cancelled && tombstoned.current !== current && alive.current && liveRef.current && current === generation.current;
    let dispose = () => {};
    const fail = (message: string) => { if (valid()) {
      tombstoned.current = current; cancelled = true; setReplyPending(false); stopSpeech(ownerId); stopAutomatic();
      setAcknowledgement(""); setProvisionalReply(""); setPlayText(undefined); changePhase("paused"); setError(message); dispose();
    } };
    const buffers = new VoiceReplyBuffers();
    const buffer = buffers.answer;
    const queuedPurposes: Array<"answer" | "acknowledgement"> = [];
    let queue: SpeechQueue | undefined;
    let streaming = false;
    let streamFailed = false;
    let statusRead: Promise<boolean> | undefined;
    let exposure: import("@ponderosa/core").VoiceReplyStatus["memoryExposure"];
    let canonicalSeen = false;
    let validationVersion = 0;
    const append = (phrases: string[], purpose: "answer" | "acknowledgement" = "answer") => {
      if (!valid() || !phrases.length) return;
      if (purpose === "answer" && timing.current) { timing.current.firstSpeakable ??= performance.now(); publishTiming(); }
      if (ttsUnavailable) return;
      if (!queue) {
        changePhase("loading");
        queue = startSpeechQueue(ownerId, preferencesRef.current, () => root.current, () => {
          if (!alive.current || current !== generation.current) return;
          dispose();
          changePhase("ready");
          if (handsFreeRef.current) listenRef.current();
        }, () => {
          const purpose = queuedPurposes.shift();
          if (purpose === "acknowledgement") buffers.acknowledgement.started();
          else { buffer.started(); audioStarted(current); }
        }, async () => {
          if (!valid()) return false;
          const permitted = await refreshStatus();
          if (!valid()) return false;
          if (!permitted) fail("Memory context could not be validated. Start a fresh turn; read historical text in Chat.");
          return permitted && valid();
        });
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
      if (observedRun.current && observedRun.current !== reply.runId) { fail("This turn moved to another Run. Continue in Chat."); return; }
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
        fail("Memory changed during this reply. Start a fresh turn; read historical text in Chat."); return;
      }
      if (reply.state === "failed") {
        // This intentional queue stop still awaits the exact canonical fallback.
        changePhase("waiting");
        streamFailed = true; queue?.stop(); queue = undefined; queuedPurposes.length = 0; buffer.discardQueued(); streaming = false; stopAutomatic();
        setNotice("Streaming stopped. Waiting for the exact canonical reply; read Chat if it changes."); return;
      }
      if (streamFailed) return;
      if (isAcknowledgement) {
        try {
          const accepted = buffers.accept(reply);
          if (accepted.phrases.length) { setAcknowledgement(reply.text); append(accepted.phrases, accepted.purpose); }
        } catch (error) { fail((error as Error).message); }
        return;
      }
      setRenderReply({ generation: current, inputId: messageId, runId: reply.runId, text: reply.text });
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
        if (status.runId && observedRun.current && status.runId !== observedRun.current) { fail("This turn moved to another Run. Continue in Chat."); return false; }
        if (status.runId) observedRun.current = status.runId;
        if (["failed", "cancelled", "outcome_unknown"].includes(status.runStatus ?? "")) { fail("The reply Run stopped. Continue in Chat."); return false; }
        const next = status.memoryExposure;
        if (!next || next.state === "invalid" || (next.runId && next.runId !== observedRun.current)) {
          fail("Memory or session changed during this reply. Start a fresh turn; read historical text in Chat."); return false;
        }
        if (exposure && ["valid", "disabled"].includes(exposure.state) && (next.state !== exposure.state || next.sessionResetSeq !== exposure.sessionResetSeq || next.projectGeneration !== exposure.projectGeneration || next.globalGeneration !== exposure.globalGeneration)) {
          fail("Memory context changed during this reply. Start a fresh turn; read historical text in Chat."); return false;
        }
        exposure = next;
        if (status.reply && !canonicalSeen) accept(status.reply);
        return valid() && ["disabled", "valid"].includes(next.state);
      }).catch(() => { fail("Memory context validation is unavailable. Start a fresh turn or read Chat."); return false; }).finally(() => { statusRead = undefined; });
      // A hint arriving during an older HTTP read requires a fresh read. Never
      // let the older response authorize speech after the hint.
      statusRead = request.then(permitted => valid() && version !== validationVersion ? refreshStatus() : permitted);
      return statusRead;
    };
    const stream = api.subscribeAgent(agentId, undefined, {
      onOpen: refreshStatus, onStatus: () => refreshStatus(),
      onEvent: envelope => {
        if (!valid() || envelope.agentId !== agentId) return;
        const event = envelope.event;
        if (event.type === "memory_changed" && event.projectId === projectId) {
          if (event.runId === observedRun.current && event.conversationId === conversationId) fail("Memory changed during this reply. Start a fresh turn; read historical text in Chat.");
          else { validationVersion++; void refreshStatus(); }
        } else if (event.type === "session_reset") {
          if (exposure?.sessionResetSeq !== undefined && envelope.seq > exposure.sessionResetSeq) fail("The session changed during this reply. Start a fresh turn; read historical text in Chat.");
          else if (exposure?.sessionResetSeq === undefined) { validationVersion++; void refreshStatus(); }
        }
        else if (event.type === "voice_reply" && !canonicalSeen) accept(event.reply);
        else if (event.type === "agent_lifecycle" && event.executionId === observedRun.current &&
            ["cancelled", "failed"].includes(event.status)) fail("The reply Run stopped. Continue in Chat.");
      },
    });
    refreshStatus();
    const phraseTimer = setInterval(() => { if (valid() && streaming) { try { append(buffer.flush()); } catch (error) { fail((error as Error).message); } } }, 100);
    // Nominal backstop only: network/event-loop delay is unbounded; no physical-onset atomicity.
    const exposureTimer = setInterval(() => { void refreshStatus(); }, 250);
    const deadline = setTimeout(() => fail("The Agent is still working after 120 seconds. Open Chat for its reply."), 120_000);
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
        clearTimeout(deadline);
        const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId)!;
        const receipt = sent.deliveryReceipts!.find(i => i.targetAgentId === agentId)!;
        const execution = receipt.state === "recovered" ? receipt.recoveryExecutionId : receipt.executionId;
        if (observedRun.current && observedRun.current !== execution) { fail("This turn moved to another Run. Continue in Chat."); return; }
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
          if (queue) queue.finish();
          else { dispose(); stopAutomatic(); changePhase("ready"); setNotice("Read the canonical reply in the transcript or Chat."); }
        } catch (error) { fail((error as Error).message); return; }
        setReplyPending(false);
        return;
      }
      const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId);
      const receipt=sent?.deliveryReceipts?.find(i=>i.targetAgentId===agentId);
      if(receipt?.steeringWaitReason) {
        const reason=receipt.steeringWaitReason;
        setDeliveryNotice(reason==="provider_unsupported" ? "This connection cannot interrupt the current work. Your priority turn is waiting; follow it in Chat."
          : reason==="provider_not_ready" || reason==="run_starting" ? "Connecting your priority turn…"
          : reason==="context_refresh" ? "Refreshing the connection before your turn…"
          : "Waiting for the current instruction to reach the connection…");
      } else if(receipt?.state==="unconfirmed") setDeliveryNotice("Delivery is unconfirmed. Review this turn in Chat before trying again.");
      else setDeliveryNotice(undefined);
      if (!queue && sent?.deliveryReceipts?.some(i => i.targetAgentId === agentId && ["started", "delivered", "processed", "recovering", "recovered"].includes(i.state))) changePhase("waiting");
    };
    const unsubscribe = observer.subscribe(observe);
    dispose = () => {
      cancelled = true; stream.close(); clearInterval(phraseTimer); clearInterval(exposureTimer); unsubscribe(); observer.destroy(); clearTimeout(deadline);
      if (observationCleanup.current === dispose) observationCleanup.current = undefined;
    };
    observationCleanup.current = dispose;
    return dispose;
  }, [ messageId, conversationId, agentId, ownerId, product, queryClient, changePhase, suspend, stopAutomatic]);
  useEffect(() => {
    if (!muted && handsFree && phase === "ready") listenRef.current();
  }, [muted, handsFree, phase]);
  const recording = ["starting", "listening", "pausing", "stopping"].includes(dictation.status);
  const inFlight = replyPending || ["sending", "queued", "waiting", "loading", "speaking"].includes(phase);
  const status = muted && phase === "capture" ? "Microphone muted" : phase === "capture" ? dictation.status === "starting" ? "Opening microphone…" : dictation.status === "stopping" ? "Finishing your words…" : "Listening to you"
    : phase === "queued" ? "Connecting your turn…" : phase === "waiting" ? "Thinking about your turn…" : phase === "loading" ? "Preparing voice…" : phase === "speaking" ? "Speaking to you" : phase === "sending" ? "Sending your turn…" : muted ? "Microphone muted" : phase === "paused" ? "Call interrupted" : phase === "review" ? "Your turn, ready to send" : handsFree ? "Ready to listen" : "Ready when you are";
  const availableAgents = agents.filter(a => member(a, projectId, conversationId));
  const agentName = availableAgents.find(a => a.id === agentId)?.title ?? "Choose an Agent";
  const initials=agentName.split(/\s+/u).filter(Boolean).slice(0,2).map(word=>word[0]).join("").toLocaleUpperCase();
  const cannotStart = !live || !checked || muted || Boolean(sttUnavailable) || recording || inFlight || recovering || Boolean(attempt.current) || blocked || Boolean(text.trim());
  const interruptReply = () => {
    const settled=stopSpeech(ownerId); abandon();
    if(!settled){stopAutomatic();changePhase("paused");setError(speechSnapshot().error);return;}
    changePhase("ready");listenRef.current();
  };
  const toggleMute = () => {
    if(!muted && recording){dictation.abandon();setText("");changePhase("ready");setNotice("Microphone muted. Unfinished words were discarded.");}
    setMuted(value=>!value);
  };
  const roundControl={minWidth:64,width:64,height:64,borderRadius:"50%",p:0,transition:"background-color 180ms ease, transform 180ms ease", "& svg":{fontSize:27}, "&:active":{transform:"scale(.95)"}, "@media (prefers-reduced-motion: reduce)":{transition:"none"}};
  return <Dialog open fullWidth fullScreen={phone} maxWidth="sm" aria-labelledby={`${ownerId}-title`} onClose={end}
    PaperProps={{sx:{m:{xs:0,sm:3},width:{xs:"100%",sm:480},height:{xs:"100%",sm:"min(780px, calc(100dvh - 48px))"},maxHeight:{xs:"100%",sm:"calc(100dvh - 48px)"},borderRadius:{xs:0,sm:6},overflow:"hidden",backgroundImage:"none",bgcolor:"background.default",boxShadow:{sm:"0 28px 100px rgba(18,28,22,.2)"}}}}
    sx={{"& .MuiDialog-container":{alignItems:"center"}}}>
    <DialogContent ref={mountSurface} sx={{p:0,display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{px:3,pt:"max(24px, env(safe-area-inset-top))",pb:1,flexShrink:0}}>
        <Stack direction="row" spacing={1} alignItems="center"><PhoneIcon sx={{fontSize:16,color:"text.secondary"}}/><Typography variant="caption" color="text.secondary" sx={{fontWeight:600,letterSpacing:".04em"}}>PONDEROSA CALL</Typography></Stack>
        <Button size="small" aria-label="Transcript" aria-expanded={expanded} aria-controls={`${ownerId}-details`} onClick={()=>setExpanded(value=>!value)} sx={{minHeight:44,minWidth:44,borderRadius:3,color:expanded?"primary.main":"text.secondary"}}><NotesRoundedIcon/><Box component="span" sx={{ml:.75}}>Transcript</Box></Button>
      </Stack>
      <Box sx={{flex:1,minHeight:0,overflowY:"auto",px:{xs:3,sm:4},display:"flex",flexDirection:"column"}}>
        <Stack alignItems="center" sx={{pt:expanded?2:{xs:5,sm:5},pb:3,transition:"padding 180ms ease","@media (prefers-reduced-motion: reduce)":{transition:"none"}}}>
          <Box aria-hidden sx={{width:expanded?88:128,height:expanded?88:128,borderRadius:"50%",display:"grid",placeItems:"center",bgcolor:"primary.main",color:"primary.contrastText",fontSize:expanded?30:44,fontWeight:600,letterSpacing:"-.04em",boxShadow:"0 12px 40px rgba(24,55,41,.10)",mb:3,transition:"width 180ms ease, height 180ms ease","@media (prefers-reduced-motion: reduce)":{transition:"none"}}}>{initials}</Box>
          <Typography id={`${ownerId}-title`} component="h1" sx={{fontSize:{xs:30,sm:32},fontWeight:600,letterSpacing:"-.04em",textAlign:"center",lineHeight:1.2}}>{agentName}</Typography>
          <Box role="status" aria-live="polite" sx={{display:"flex",alignItems:"center",gap:1,mt:1.5,color:"text.secondary",textAlign:"center"}}>
            {recording && !muted && <Box aria-hidden sx={{width:7,height:7,borderRadius:"50%",bgcolor:"success.main"}}/>}<Typography sx={{fontSize:15}}>{recovering?"Checking your connection…":status}</Typography>
          </Box>
          {handsFree && !error && <Typography variant="caption" color="text.secondary" sx={{mt:1}}>Speak naturally. Finalized turns send automatically.</Typography>}
        </Stack>
        {!locked && availableAgents.length>1 && <TextField select SelectProps={{native:true}} label="Call Agent" value={agentId} disabled={recording||inFlight||Boolean(attempt.current)} onChange={e=>setAgentId(e.target.value)} sx={{mb:2}}>
          <option value="" disabled>Choose an Agent</option>{availableAgents.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}
        </TextField>}
        <Stack spacing={1} sx={{mb:2,"& .MuiAlert-root":{borderRadius:3,fontSize:13}}>
          {sttUnavailable && <Alert severity="info">{sttUnavailable} Type a turn in Transcript.</Alert>}
          {ttsUnavailable && <Alert severity="info">{ttsUnavailable} Replies remain in Chat.</Alert>}
          {deliveryNotice && <Alert severity="info">{deliveryNotice}</Alert>}
          {notice && <Alert severity="info">{notice}</Alert>}
          {error && <Alert severity="warning">{error}</Alert>}
        </Stack>
        {text.trim() && !expanded && <Box sx={{p:2.5,borderRadius:4,bgcolor:"background.paper",mb:2}}><Typography variant="caption" color="text.secondary">{recording?"Your words":"Review your turn"}</Typography><Typography sx={{mt:.5,whiteSpace:"pre-wrap",maxHeight:140,overflowY:"auto",fontSize:16,lineHeight:1.5}}>{text}</Typography></Box>}
        {acknowledgement && !expanded && <Typography aria-label="Agent acknowledgement" sx={{textAlign:"center",fontSize:16,lineHeight:1.6,mb:2}}>{acknowledgement}</Typography>}
        {expanded && <Stack id={`${ownerId}-details`} spacing={2} sx={{pb:2}}>
          {provisionalReply && <Box sx={{p:2,borderRadius:3,bgcolor:"background.paper"}}><Typography variant="caption" color="text.secondary">Replying</Typography><Typography ref={replyElement} aria-label="Streaming reply" sx={{whiteSpace:"pre-wrap",mt:.5,lineHeight:1.6}}>{provisionalReply}</Typography></Box>}
          <Stack aria-label="Call transcript" spacing={1.5}>{transcript.map(message=><Box key={message.id} sx={{p:2,borderRadius:3,bgcolor:message.role==="user"?"action.hover":"background.paper",ml:message.role==="user"?3:0,mr:message.role==="user"?0:3}}><Typography variant="caption" color="text.secondary">{message.role==="user"?"You":agentName}</Typography><Typography ref={renderReply?.canonicalId===message.id?replyElement:undefined} sx={{whiteSpace:"pre-wrap",mt:.5,lineHeight:1.6}}>{message.document?"Full reply available in Chat.":message.text}</Typography></Box>)}</Stack>
          <TextField label="Type a turn" InputLabelProps={{shrink:true}} multiline minRows={2} value={text} disabled={recording||inFlight||recovering||Boolean(attempt.current)||blocked} onChange={e=>setText(e.target.value)} sx={{"& .MuiOutlinedInput-root":{borderRadius:3}}}/>
          <Stack direction="row" spacing={1} sx={{flexWrap:"wrap",gap:1,"& button":{minHeight:44}}}>
            {text.trim()&&!recording&&!inFlight && <Button disabled={Boolean(attempt.current)||blocked} onClick={()=>setText("")}>Clear draft</Button>}
            {handsFree&&recording&&<Button onClick={()=>{stopAutomatic();dictation.abandon();changePhase("review");}}>Review before sending</Button>}
            {playText&&!inFlight&&!recording&&!ttsUnavailable&&<Button onClick={()=>play(playText)}>Play reply</Button>}
            {replyPending&&observedRun.current&&<Button color="error" onClick={async()=>{const targetRunId=observedRun.current;if(!targetRunId)return;stopAutomatic();abandon();changePhase("paused");try{await api.cancelRun(agentId,{targetRunId,idempotencyKey:createClientId()});setNotice("Reply cancelled. Reconnect when ready.");}catch{setError("Cancellation could not be confirmed. Check Chat; audio is stopped.");}}}>Cancel reply</Button>}
          </Stack>
          {latency&&<Box component="details"><Box component="summary" sx={{cursor:"pointer",minHeight:44,display:"flex",alignItems:"center",fontSize:12,color:"text.secondary"}}>Call timing</Box><Typography aria-label="Call timing" variant="caption">{latency}</Typography></Box>}
        </Stack>}
        <Box sx={{flex:1}}/>
        {attempt.current&&<Stack alignItems="center" spacing={1} sx={{pb:2}}><Typography variant="caption" color="text.secondary">This turn is unconfirmed. Retry keeps the same identity.</Typography><Button variant="outlined" disabled={!live||!checked||recording||inFlight||recovering||blocked||!retryable} onClick={()=>{void send();}} sx={{minHeight:44,borderRadius:8}}>Retry same turn</Button></Stack>}
        {!recording&&!inFlight&&phase!=="paused"&&!text.trim()&&!attempt.current&&!handsFree&&<Typography variant="caption" color="text.secondary" sx={{textAlign:"center",pb:2}}>Browser speech may use remote processing.</Typography>}
      </Box>
      <Box sx={{flexShrink:0,px:3,pt:2,pb:"max(24px, env(safe-area-inset-bottom))",borderTop:"1px solid",borderColor:"divider",bgcolor:"background.paper"}}>
        <Stack direction="row" justifyContent="center" alignItems="flex-start" spacing={4}>
          <Stack spacing={1} alignItems="center"><Button aria-label={muted?"Unmute microphone":"Mute microphone"} aria-pressed={muted} disabled={Boolean(sttUnavailable)||(!handsFree&&!recording&&!muted)} onClick={toggleMute} sx={{...roundControl,bgcolor:muted?"text.primary":"action.hover",color:muted?"background.paper":"text.primary","&:hover":{bgcolor:muted?"text.secondary":"action.selected"}}}>{muted?<MicOffIcon/>:<MicNoneIcon/>}</Button><Typography variant="caption" color="text.secondary">{muted?"Unmute":"Mute"}</Typography></Stack>
          <Stack spacing={1} alignItems="center">
            {phase==="loading"||phase==="speaking"?<Button aria-label="Talk now" disabled={muted||Boolean(sttUnavailable)} onClick={interruptReply} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><MicNoneIcon/></Button>
              :phase==="paused"?<Button aria-label="Reconnect call" disabled={recovering||blocked||Boolean(attempt.current)} onClick={()=>{void resume();}} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><PhoneIcon/></Button>
              :recording?<Button aria-label="Finish turn" disabled={dictation.status==="stopping"} onClick={dictation.stop} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><SendRoundedIcon/></Button>
              :text.trim()?<Button aria-label="Send turn" disabled={!live||!checked||inFlight||recovering||blocked||Boolean(attempt.current)} onClick={()=>{void send();}} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><SendRoundedIcon/></Button>
              :<Button aria-label={handsFree?"Listen":"Start call"} disabled={cannotStart} onClick={startCall} sx={{...roundControl,bgcolor:"primary.main",color:"primary.contrastText","&:hover":{bgcolor:"primary.dark"}}}><PhoneIcon/></Button>}
            <Typography variant="caption" color="text.secondary">{phase==="loading"||phase==="speaking"?"Talk now":phase==="paused"?"Reconnect":recording?"Finish turn":text.trim()?"Send turn":handsFree?"Listen":"Call"}</Typography>
          </Stack>
          <Stack spacing={1} alignItems="center"><Button aria-label="End call" onClick={end} sx={{...roundControl,bgcolor:"error.main",color:"error.contrastText","&:hover":{bgcolor:"error.dark"}}}><CallEndIcon/></Button><Typography variant="caption" color="text.secondary">End</Typography></Stack>
        </Stack>
      </Box>
    </DialogContent>
  </Dialog>;
}
