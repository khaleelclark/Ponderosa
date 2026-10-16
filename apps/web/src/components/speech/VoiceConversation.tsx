import {createClientId} from '../../clientId';
import PhoneIcon from "@mui/icons-material/Phone";
import CallEndIcon from "@mui/icons-material/CallEnd";
import MicOffIcon from "@mui/icons-material/MicOff";
import MicNoneIcon from "@mui/icons-material/MicNone";
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, Stack, TextField, Typography, useMediaQuery } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type AgentDto, type ConversationDetailDto, type ConversationMessageDto } from "@ponderosa/core";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { productApiPath } from "../../api/productScope";
import { useWorkspacePreferences } from "../../hooks/queries";
import { queryKeys } from "../../queryKeys";
import { publishConversationMessageReceipt } from "../../conversationMessageReceipt";
import { dictationUnavailableReason, speechSynthesisUnavailableReason } from "./browserSpeech";
import { speechSnapshot, startSpeech, startSpeechQueue, stopSpeech, subscribeSpeech, type SpeechQueue } from "./speechCoordinator";
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";
import { speakableMessageText } from "./speechText";
import { useDictation } from "./useDictation";
import { VoicePhraseBuffer, voiceTimingText, type VoiceTiming } from "./voiceReplyStream";
import { voiceReplyInWindow } from "./voiceReply";
import { VOICE_ATTEMPT_TTL, prepareVoiceCallAttempt, restoreVoiceCallAttempt, retainVoiceCallAttempt, settleVoiceCallAttempt, voiceCallAttemptCanRetry, type VoiceCallAttempt, type VoiceRoute } from "./voiceCallAttempt";

type Phase = "ready" | "capture" | "review" | "sending" | "queued" | "waiting" | "loading" | "speaking" | "paused";
export interface VoiceConversationContext {
  projectId: string; conversationId: string; agents: AgentDto[];
  selectedAgentId?: string; lockAgent?: boolean; pinecone?: boolean;
}
const member = (agent: AgentDto, projectId: string, conversationId: string) => !agent.archived && agent.projectId === projectId && agent.conversationId === conversationId;
export function VoiceConversation(props: VoiceConversationContext & { open: boolean; onClose(): void }): JSX.Element {
  const product = productApiPath("/api/conversations");
  return <>{props.open && <VoiceSession key={JSON.stringify([product, props.projectId, props.conversationId, props.selectedAgentId])} {...props} product={product} />}</>;
}
function VoiceSession({ projectId, conversationId, agents, selectedAgentId, lockAgent, onClose, product, pinecone }: VoiceConversationContext & { onClose(): void; product: string }): JSX.Element {
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
  const [expanded, setExpanded] = useState(Boolean(pinecone && dictationUnavailableReason()));
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
  const observedRun = useRef<string>();
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
    if (!attempt.current) { timing.current = { settled: recognitionSettled.current }; recognitionSettled.current = undefined; setLatency(undefined); setRenderReply(undefined); setProvisionalReply(""); observedRun.current = undefined; }
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
      setProvisionalReply(""); setPlayText(undefined); changePhase("paused"); setError(message); dispose();
    } };
    const buffer = new VoicePhraseBuffer();
    let queue: SpeechQueue | undefined;
    let streaming = false;
    let streamFailed = false;
    let statusRead: Promise<boolean> | undefined;
    let exposure: import("@ponderosa/core").VoiceReplyStatus["memoryExposure"];
    let canonicalSeen = false;
    let validationVersion = 0;
    const append = (phrases: string[]) => {
      if (!valid() || !phrases.length) return;
      if (timing.current) { timing.current.firstSpeakable ??= performance.now(); publishTiming(); }
      if (ttsUnavailable) return;
      if (!queue) {
        changePhase("loading");
        queue = startSpeechQueue(ownerId, preferencesRef.current, () => root.current, () => {
          if (!alive.current || current !== generation.current) return;
          dispose();
          changePhase("ready");
          if (handsFreeRef.current) listenRef.current();
        }, () => {
          buffer.started();
          audioStarted(current);
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
        if (!queue.append(phrase)) { fail(speechSnapshot().error ?? "Browser speech paused. Read the reply in Chat."); break; }
        if (timing.current) { timing.current.firstQueued ??= queuedAt; publishTiming(); }
      }
    };
    const accept = (reply: import("@ponderosa/core").VoiceReplySnapshot) => {
      if (!valid() || reply.projectId !== projectId || reply.conversationId !== conversationId ||
          reply.agentId !== agentId || reply.messageId !== messageId) return;
      if (observedRun.current && observedRun.current !== reply.runId) { fail("This turn moved to another Run. Continue in Chat."); return; }
      observedRun.current = reply.runId;
      if (timing.current) {
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
        streamFailed = true; queue?.stop(); queue = undefined; buffer.discardQueued(); streaming = false; stopAutomatic();
        setNotice("Streaming stopped. Waiting for the exact canonical reply; read Chat if it changes."); return;
      }
      if (streamFailed) return;
      setRenderReply({ generation: current, inputId: messageId, runId: reply.runId, text: reply.text });
      setProvisionalReply(reply.text);
      if (reply.state !== "streaming") return;
      streaming = true;
      try { append(buffer.accept(reply)); } catch (error) { fail((error as Error).message); }
    };
    const refreshStatus = (): Promise<boolean> => {
      if (!valid()) return Promise.resolve(false);
      if (statusRead) return statusRead;
      const version = validationVersion;
      const request = api.getVoiceReplyStatus(conversationId, messageId, agentId).then(status => {
        if (!valid() || status.messageId !== messageId || version !== validationVersion) return false;
        if (timing.current) {
          Object.assign(timing.current, { acceptedAt: status.acceptedAt, leasedAt: status.leasedAt, runStartedAt: status.runStartedAt,
            submittedAt: status.reply?.submittedAt ?? timing.current.submittedAt, firstModelTextAt: status.reply?.firstModelTextAt ?? timing.current.firstModelTextAt,
            firstTextAt: status.reply?.firstTextAt ?? timing.current.firstTextAt, completedAt: status.reply?.completedAt ?? timing.current.completedAt });
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
          const original = event.scope === "project" ? exposure?.projectGeneration : exposure?.globalGeneration;
          if (original === undefined) { validationVersion++; void refreshStatus(); }
          else if (event.generation > original) fail("Memory changed during this reply. Start a fresh turn; read historical text in Chat.");
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
    const phraseTimer = setInterval(() => { if (valid() && streaming) { try { append(buffer.flush()); } catch (error) { fail((error as Error).message); } } }, 900);
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
      const reply = voiceReplyInWindow(messageId, detail.messages, agentId);
      if (reply) {
        if ("error" in reply) { fail(reply.error); return; }
        clearTimeout(deadline);
        const sent = detail.messages.find(i => i.id === messageId || i.communicationEventId === messageId)!;
        const receipt = sent.deliveryReceipts!.find(i => i.targetAgentId === agentId)!;
        const execution = receipt.state === "recovered" ? receipt.recoveryExecutionId : receipt.executionId;
        if (observedRun.current && observedRun.current !== execution) { fail("This turn moved to another Run. Continue in Chat."); return; }
        observedRun.current = execution;
        const answer = detail.messages.find(i => i.conversationId === conversationId && i.role === "assistant" && i.communicationIntent === "user_dm" && i.authorAgentId === agentId && i.executionId === execution)!;
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
  const recording = ["starting", "listening", "pausing", "stopping"].includes(dictation.status);
  const inFlight = replyPending || ["sending", "queued", "waiting", "loading", "speaking"].includes(phase);
  const status = phase === "capture" ? dictation.status === "starting" ? "Starting microphone…" : dictation.status === "stopping" ? "Finishing transcript…" : "Listening…"
    : phase === "queued" ? (pinecone ? "Your turn is queued…" : "Queued for the Agent…") : phase === "waiting" ? (pinecone ? "Thinking…" : "Waiting for the Agent… Agent working") : phase === "loading" ? "Loading speech…" : phase === "speaking" ? "Speaking…" : phase === "sending" ? "Sending…" : muted ? "Microphone muted" : phase === "paused" ? "Call paused" : "Microphone off";
  const availableAgents = agents.filter(a => member(a, projectId, conversationId));
  const agentName = availableAgents.find(a => a.id === agentId)?.title ?? "Choose an Agent";
  const cannotStart = !live || !checked || muted || Boolean(sttUnavailable) || recording || inFlight || recovering || Boolean(attempt.current) || blocked || Boolean(text.trim());
  return <Dialog open fullWidth fullScreen={Boolean(pinecone && phone)} maxWidth="xs" aria-labelledby={`${ownerId}-title`} onClose={end}
    PaperProps={{ sx: pinecone && phone ? { m: 0, width: "100%", borderRadius: 0, maxHeight: "100%" } : { m: { xs: 1, sm: 4 }, width: { xs: "calc(100% - 16px)", sm: "100%" }, borderRadius: 3, maxHeight: "calc(100% - 32px)" } }}
    sx={{ "& .MuiDialog-container": { alignItems: { xs: "flex-end", sm: "center" } } }}>
    <DialogTitle id={`${ownerId}-title`} sx={{ textAlign: "center", pb: 0 }}>{agentName}</DialogTitle>
    <DialogContent ref={mountSurface}><Stack spacing={2} sx={{ pt: 2 }}>
      {!locked && availableAgents.length > 1 && <TextField select SelectProps={{ native: true }} label="Call Agent" value={agentId} disabled={recording || inFlight || Boolean(attempt.current)} onChange={e => setAgentId(e.target.value)}>
        <option value="" disabled>Choose an Agent</option>
        {availableAgents.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
      </TextField>}
      <Box role="status" aria-live="polite" sx={{ textAlign: "center", py: 2 }}>
        <Box aria-hidden sx={{ width: 56, height: 56, borderRadius: "50%", bgcolor: recording || phase === "speaking" ? "primary.main" : "action.hover", color: recording || phase === "speaking" ? "primary.contrastText" : "text.secondary", display: "grid", placeItems: "center", mx: "auto", mb: 1.5 }}><PhoneIcon /></Box>
        <Typography>{phase === "ready" && !muted ? sttUnavailable ? "Calling unavailable · typing is available" : "Ready to call" : status}</Typography>
        {handsFree && <Typography variant="caption" color="text.secondary">Hands-free call active · automatic finalized turns</Typography>}
      </Box>
      {(phase === "ready" || phase === "paused") && !handsFree && !sttUnavailable && <Typography variant="caption" color="text.secondary" sx={{ textAlign: "center" }}>{pinecone ? "Start call to talk with Pinecone. Each finished turn is sent automatically." : "Start call sends each finalized spoken turn automatically as a private message."} Browser speech may use the browser vendor’s remote processing.</Typography>}
      {sttUnavailable && <Alert severity="info">{sttUnavailable} {pinecone ? "Type your turn below. Replies use native speech when available." : "Use Chat or expand Transcript & typing."}</Alert>}
      {ttsUnavailable && <Alert severity="info">{ttsUnavailable} Read replies in Chat.</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}
      {error && <Alert severity="warning">{error}</Alert>}
      <Stack direction="row" spacing={1} justifyContent="center" sx={{ flexWrap: "wrap", gap: 1, "& button": { minHeight: 48 } }}>
        {(phase === "loading" || phase === "speaking") ? <Button variant="contained" disabled={muted || Boolean(sttUnavailable)} onClick={() => {
          const settled = stopSpeech(ownerId);
          abandon();
          if (!settled) { stopAutomatic(); changePhase("paused"); setError(speechSnapshot().error); return; }
          changePhase("ready"); listenRef.current();
        }}>Talk now</Button> : phase === "paused" ? <Button variant="contained" disabled={recovering || blocked || Boolean(attempt.current)} onClick={() => { void resume(); }}>Resume call</Button>
          : !recording && !inFlight && <Button variant="contained" disabled={cannotStart} onClick={startCall}>Start call</Button>}
        <Button disabled={Boolean(sttUnavailable) || (!handsFree && !recording && !muted)} aria-pressed={muted} startIcon={muted ? <MicOffIcon /> : <MicNoneIcon />} onClick={() => { if (!muted) { stopAutomatic(); abandon(); changePhase("paused"); setNotice("Microphone muted. Unfinished words were discarded."); } setMuted(!muted); }}>{muted ? "Unmute microphone" : "Mute microphone"}</Button>
        <Button color="error" startIcon={<CallEndIcon />} onClick={end}>End call</Button>
      </Stack>
      {attempt.current && <Button disabled={!live || !checked || recording || inFlight || recovering || blocked || !retryable} onClick={() => { void send(); }}>Retry same turn</Button>}
      {playText && error && !inFlight && !recording && !ttsUnavailable && !expanded && <Button onClick={() => play(playText)}>Play reply</Button>}
      <Button size="small" sx={{ minHeight: 44 }} aria-expanded={expanded} aria-controls={`${ownerId}-details`} onClick={() => setExpanded(value => !value)}>Transcript &amp; typing</Button>
      {expanded && <Stack id={`${ownerId}-details`} spacing={2}>
        {latency && <Typography aria-label="Call timing" variant="caption">{latency} Recognition finalization and provider time vary; these are this turn’s observed intervals.</Typography>}
        {provisionalReply && <Typography ref={replyElement} aria-label="Streaming reply" sx={{ whiteSpace: "pre-wrap" }}>{provisionalReply}</Typography>}
        <Box aria-label="Call transcript">{transcript.map(message => <Box key={message.id} sx={{ mb: 1 }}><Typography variant="caption">{message.role === "user" ? "You" : pinecone ? "Pinecone" : "Agent"}</Typography><Typography ref={renderReply?.canonicalId === message.id ? replyElement : undefined} sx={{ whiteSpace: "pre-wrap" }}>{message.document ? "Full message available in Chat." : message.text}</Typography></Box>)}</Box>
        <TextField label="Your next turn" multiline minRows={2} value={text} disabled={recording || inFlight || recovering || Boolean(attempt.current) || blocked} onChange={e => setText(e.target.value)} />
        {text.trim() && !recording && !inFlight && <Typography variant="caption">Send or clear your draft before starting a call.</Typography>}
        {replyPending && observedRun.current && <Button onClick={async () => {
          const targetRunId = observedRun.current; if (!targetRunId) return;
          stopAutomatic(); abandon(); changePhase("paused");
          try { await api.cancelRun(agentId, { targetRunId, idempotencyKey: createClientId() }); setNotice("Reply cancelled. Resume deliberately."); }
          catch { setError("Cancellation could not be confirmed. Check Chat; audio is stopped."); }
        }}>Cancel reply</Button>}
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1, "& button": { minHeight: 48 } }}>
          {(phase === "loading" || phase === "speaking") && <Button onClick={() => { stopAutomatic(); abandon(); changePhase("ready"); }}>Stop speaking</Button>}
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
