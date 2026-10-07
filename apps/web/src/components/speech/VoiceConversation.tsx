import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type AgentDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { useWorkspacePreferences } from "../../hooks/queries";
import { queryKeys } from "../../queryKeys";
import { publishConversationMessageReceipt } from "../../conversationMessageReceipt";
import { dictationUnavailableReason, speechSynthesisUnavailableReason } from "./browserSpeech";
import { speechSnapshot, startSpeech, stopSpeech, subscribeSpeech } from "./speechCoordinator";
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";
import { speakableMessageText } from "./speechText";
import { useDictation } from "./useDictation";
import { voiceReplyInWindow } from "./voiceReply";

type Phase = "ready" | "listening" | "review" | "sending" | "waiting" | "speaking" | "paused";

export interface VoiceConversationContext {
  projectId: string; conversationId: string; agents: AgentDto[];
}
export function VoiceConversation({ projectId, conversationId, agents, open, onClose }: VoiceConversationContext & {
  open: boolean; onClose(): void;
}): JSX.Element {
  return <>
    {open && <VoiceSession key={conversationId} projectId={projectId} conversationId={conversationId} agents={agents.filter(a => !a.archived)} onClose={onClose} />}
  </>;
}

function VoiceSession({ conversationId, agents, onClose }: {
  projectId: string; conversationId: string; agents: AgentDto[]; onClose(): void;
}): JSX.Element {
  const ownerId = useId();
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [agentId, setAgentId] = useState(agents.length === 1 ? agents[0]!.id : "");
  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef(phase);
  const changePhase = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [messageId, setMessageId] = useState<string>();
  const attempt = useRef<{ text: string; idempotencyKey: string }>();
  const queryClient = useQueryClient();
  const { data: workspace } = useWorkspacePreferences();
  const playback = useSyncExternalStore(subscribeSpeech, speechSnapshot);
  const preferences = workspace?.speech ?? DEFAULT_SPEECH_PREFERENCES;
  const unavailable = dictationUnavailableReason() ?? speechSynthesisUnavailableReason();
  const dictation = useDictation(transcript => {
    if (phaseRef.current === "listening" || phaseRef.current === "review") {
      setText(current => [current, transcript].filter(Boolean).join(" "));
    }
  }, () => {}, root, false);
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  const pause = useCallback(() => {
    generation.current++;
    changePhase(phaseRef.current === "listening" ? "review" : "paused");
    dictationRef.current.stop();
    stopSpeech(ownerId);
  }, [changePhase, ownerId]);
  const listen = () => {
    if (!agentId || attempt.current || !agents.some(a => a.id === agentId)) return;
    stopSpeech();
    setError(undefined);
    changePhase("listening");
    dictation.start();
  };
  useEffect(() => {
    if (dictation.status === "error") {
      changePhase("paused"); setError(dictation.error);
    } else if (dictation.status === "stopped" && phaseRef.current === "listening") {
      changePhase("review");
    }
  }, [dictation.status, dictation.error, changePhase]);
  useEffect(() => {
    if (playback.ownerId !== ownerId || phaseRef.current !== "speaking") return;
    if (playback.status === "error" || playback.status === "stopped") {
      changePhase("paused");
      if (playback.error) setError(playback.error);
    }
  }, [playback, ownerId, changePhase]);
  useEffect(() => {
    if (!["listening", "sending", "waiting", "speaking"].includes(phase)) return;
    const cleanup = monitorSpeechSurfaceAccessibility(() => root.current, pause);
    return cleanup;
  }, [ownerId, pause, phase]);

  useEffect(() => () => { generation.current++; stopSpeech(ownerId); }, [ownerId]);

  const send = async () => {
    if (!agentId || ["sending", "waiting", "speaking", "listening"].includes(phaseRef.current)) return;
    const pending = attempt.current ?? { text: text.trim(), idempotencyKey: crypto.randomUUID() };
    if (!pending.text) return;
    attempt.current = pending;
    const current = ++generation.current;
    setError(undefined); changePhase("sending");
    try {
      const response = await api.sendMultiAgentDirectMessage(conversationId, {
        ...pending, recipients: [{ agentId }], activeRunDelivery: "queue",
      });
      void publishConversationMessageReceipt(queryClient, conversationId, response.message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(conversationId) });
      if (generation.current !== current) return;
      if (response.unavailableRecipients?.length) throw new Error("This Agent is unavailable. Check the Chat before trying again.");
      attempt.current = undefined;
      setText(""); setMessageId(response.messageId); changePhase("waiting");
    } catch (failure) {
      if (generation.current !== current) return;
      changePhase("paused");
      setError(`Could not confirm this turn. Retry uses the same message identity. ${failure instanceof Error ? failure.message : "Check the Chat."}`);
    }
  };

  useEffect(() => {
    if (phase !== "waiting" || !messageId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      try {
        if (Date.now() - started > 120_000) throw new Error("The Agent is still working. Check the Chat for its reply.");
        const detail = await api.getConversation(conversationId, 20);
        if (cancelled) return;
        {
          const reply = voiceReplyInWindow(messageId, detail.messages, agentId);
          if (reply) {
            if ("error" in reply) throw new Error(reply.error);
            const spoken = speakableMessageText(reply.text);
            if (!spoken) throw new Error("The reply has no spoken text. Check the Chat.");
            changePhase("speaking");
            startSpeech(ownerId, spoken, preferences, () => root.current, () => {
              // ponytail: explicit next-turn tap avoids browser-dependent microphone reactivation.
              // Automatic listening follows real-device qualification of permission and echo handling.
              changePhase("ready");
            });
            return;
          }
        }
        timer = setTimeout(() => { void poll(); }, 1500);
      } catch (failure) {
        if (!cancelled) { changePhase("paused"); setError(failure instanceof Error ? failure.message : "Could not load the reply. Check the Chat."); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, messageId, conversationId, agentId, ownerId, preferences, changePhase]);

  const recording = ["starting", "listening", "pausing", "stopping"].includes(dictation.status);
  const inFlight = phase === "sending" || phase === "waiting" || phase === "speaking";
  return <Dialog open fullWidth maxWidth="sm" disableEscapeKeyDown onClose={() => {}}>
    <DialogTitle>Talk · Beta12 preview</DialogTitle>
    <DialogContent ref={root}>
      <Stack spacing={2} sx={{ pt: 1 }}>
        <Typography variant="body2">Speak, review your words, then send. The Agent’s completed reply plays aloud. Each turn is a direct message in this Chat.</Typography>
        <TextField select label="Talk to" value={agentId} disabled={recording || inFlight || Boolean(attempt.current) || Boolean(messageId)} onChange={event => setAgentId(event.target.value)}>
          {agents.map(agent => <MenuItem key={agent.id} value={agent.id}>{agent.title}</MenuItem>)}
        </TextField>
        {unavailable && <Alert severity="info">{unavailable}</Alert>}
        {error && <Alert severity="warning">{error}</Alert>}
        <Box role="status" aria-live="polite">{phase === "waiting" ? "Waiting for the Agent…" : phase === "speaking" ? "Reading the reply…" : recording ? "Listening…" : phase === "sending" ? "Sending…" : "Microphone off"}</Box>
        <TextField label="Your next turn" multiline minRows={3} value={text} disabled={recording || inFlight || Boolean(attempt.current)} onChange={event => setText(event.target.value)} />
        <Typography variant="caption">Preview uses browser speech. Tap Listen for each turn. Ending the session discards unsent text and stops audio; already-sent work continues in the Chat. Check Chat before resending an unconfirmed turn after closing.</Typography>
      </Stack>
    </DialogContent>
    <DialogActions>
      <Button onClick={() => { pause(); onClose(); }}>End session</Button>
      {(recording || inFlight) && <Button onClick={pause}>Pause</Button>}
      <Button disabled={!agentId || Boolean(unavailable) || recording || inFlight || Boolean(attempt.current)} onClick={listen}>Listen</Button>
      <Button disabled={!agentId || !text.trim() || recording || inFlight} onClick={() => { void send(); }}>{attempt.current ? "Retry turn" : "Send turn"}</Button>
    </DialogActions>
  </Dialog>;
}
