import MicNoneIcon from "@mui/icons-material/MicNone";
import PhoneIcon from "@mui/icons-material/Phone";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { VoiceConversation, type VoiceConversationContext } from "./VoiceConversation";
import {
  speechControlGroupSx,
  speechStatusSx,
  visuallyHiddenSpeechStatusSx,
} from "./speechStyles";
import { useDictation } from "./useDictation";

export function DictationControls({
  disabled,
  onFinalTranscript,
  onSettlingChange,
  onActiveChange,
  talkContext,
}: {
  disabled: boolean;
  onFinalTranscript(transcript: string): void;
  onSettlingChange(settling: boolean): void;
  onActiveChange?(active: boolean): void;
  talkContext?: VoiceConversationContext;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [talkOpenFor, setTalkOpenFor] = useState<string>();
  const talkKey = talkContext && JSON.stringify([talkContext.projectId, talkContext.conversationId, talkContext.selectedAgentId]);
  const talkOpen = Boolean(talkKey && talkOpenFor === talkKey);
  useEffect(() => { setTalkOpenFor(undefined); }, [talkKey]);
  const dictation = useDictation(
    onFinalTranscript,
    onSettlingChange,
    rootRef,
  );
  const active = ["starting", "listening", "pausing", "stopping"].includes(
    dictation.status,
  );
  const paused = dictation.status === "paused";
  useEffect(() => {
    onActiveChange?.(active || paused || talkOpen);
  }, [active, paused, talkOpen, onActiveChange]);
  const busy = dictation.status === "pausing" || dictation.status === "stopping";
  const canStopForDisabled =
    dictation.status === "starting" ||
    dictation.status === "listening" ||
    paused;

  useEffect(() => {
    if (disabled && canStopForDisabled) dictation.stop();
  }, [canStopForDisabled, dictation.stop, disabled]);

  const unavailable = dictation.unavailableReason;
  const callAvailable = talkContext?.agents.some(agent => !agent.archived && agent.projectId === talkContext.projectId && agent.conversationId === talkContext.conversationId && (!talkContext.selectedAgentId || agent.id === talkContext.selectedAgentId));
  const primaryLabel = unavailable
    ? unavailable
    : dictation.status === "listening" || dictation.status === "starting"
      ? "Pause voice dictation"
      : paused
        ? "Resume voice dictation"
        : "Start voice dictation";
  const statusLabel = dictation.error
    ? dictation.error
    : dictation.status === "starting"
      ? "Starting dictation…"
      : dictation.status === "listening"
        ? "Listening…"
        : dictation.status === "pausing"
          ? "Pausing dictation…"
          : dictation.status === "paused"
            ? "Dictation paused"
            : dictation.status === "stopping"
              ? "Stopping dictation…"
              : dictation.status === "stopped"
                ? "Dictation stopped"
                : undefined;
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  useEffect(() => {
    setNoticeDismissed(false);
    if (!statusLabel || active || paused || dictation.error) return;
    const timer = setTimeout(() => setNoticeDismissed(true), 3000);
    return () => clearTimeout(timer);
  }, [statusLabel, active, paused, dictation.error]);

  return (
    <Box ref={rootRef} sx={speechControlGroupSx}>
      <Tooltip title={primaryLabel}>
        <span>
          <IconButton
            color={dictation.status === "listening" ? "primary" : "inherit"}
            aria-label={primaryLabel}
            aria-pressed={dictation.status === "listening"}
            disabled={disabled || Boolean(unavailable) || busy}
            onClick={() => {
              if (dictation.status === "listening" || dictation.status === "starting") {
                dictation.pause();
              } else if (paused) {
                dictation.resume();
              } else {
                dictation.start();
              }
            }}
          >
            {dictation.status === "listening" || dictation.status === "starting" ? (
              <PauseIcon />
            ) : (
              <MicNoneIcon />
            )}
          </IconButton>
        </span>
      </Tooltip>
      {talkContext && <Tooltip title="Call Agent"><span>
        <IconButton aria-label="Call Agent" aria-haspopup="dialog" disabled={disabled || !callAvailable || active || paused}
          onClick={() => setTalkOpenFor(talkKey)} sx={{ minWidth: 44, minHeight: 44 }}>
          <PhoneIcon />
        </IconButton>
      </span></Tooltip>}
      {talkContext && <VoiceConversation {...talkContext} open={talkOpen} onClose={() => setTalkOpenFor(undefined)} />}
      {active || paused ? (
        <Tooltip title="Stop voice dictation">
          <span>
            <IconButton
              aria-label="Stop voice dictation"
              disabled={busy}
              onClick={dictation.stop}
            >
              <StopIcon />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      {statusLabel && !noticeDismissed ? (
        <Typography
          aria-live="polite"
          color={dictation.error ? "error" : "text.secondary"}
          role={dictation.error ? "alert" : "status"}
          variant="caption"
          sx={[
            speechStatusSx,
            !dictation.error ? { "@media (max-width: 899.95px)": visuallyHiddenSpeechStatusSx } : {},
          ]}
          title={statusLabel}
        >
          {statusLabel}
        </Typography>
      ) : null}
      {unavailable ? (
        <Box
          component="span"
          sx={visuallyHiddenSpeechStatusSx}
        >
          {unavailable}
        </Box>
      ) : null}
    </Box>
  );
}
