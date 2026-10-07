import MicNoneIcon from "@mui/icons-material/MicNone";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import { Box, ClickAwayListener, IconButton, MenuItem, MenuList, Paper, Popper, Tooltip, Typography } from "@mui/material";
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
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [talkOpenFor, setTalkOpenFor] = useState<string>();
  const talkOpen = Boolean(talkContext && talkOpenFor === talkContext.conversationId);
  useEffect(() => { setMenuAnchor(null); setTalkOpenFor(undefined); }, [talkContext?.conversationId]);
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
    onActiveChange?.(active || paused || Boolean(menuAnchor) || talkOpen);
  }, [active, paused, menuAnchor, talkOpen, onActiveChange]);
  const busy = dictation.status === "pausing" || dictation.status === "stopping";
  const canStopForDisabled =
    dictation.status === "starting" ||
    dictation.status === "listening" ||
    paused;

  useEffect(() => {
    if (disabled && canStopForDisabled) dictation.stop();
  }, [canStopForDisabled, dictation.stop, disabled]);

  const unavailable = dictation.unavailableReason;
  const chooseMode = Boolean(talkContext) && !active && !paused;
  const primaryLabel = chooseMode ? "Voice input" : unavailable
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
            aria-haspopup={chooseMode ? "menu" : undefined}
            aria-expanded={chooseMode ? Boolean(menuAnchor) : undefined}
            disabled={disabled || (!chooseMode && Boolean(unavailable)) || busy}
            onClick={event => {
              if (chooseMode) { setMenuAnchor(event.currentTarget); return; }
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
      <Popper anchorEl={menuAnchor} open={Boolean(menuAnchor)} placement="top-end" sx={{ zIndex: 1400 }}>
      <ClickAwayListener onClickAway={() => setMenuAnchor(null)}>
      <Paper elevation={5} sx={{ mb: 0.5, minWidth: 160 }}>
      <MenuList autoFocusItem aria-label="Voice input modes" onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") { if(event.key === "Escape")event.preventDefault(); menuAnchor?.focus({ preventScroll: true }); setMenuAnchor(null); }
      }}>
        <MenuItem disabled={disabled || Boolean(unavailable)} onClick={() => { setMenuAnchor(null); dictation.start(); }}>Dictate</MenuItem>
        <MenuItem disabled={disabled || !talkContext?.agents.some(agent => !agent.archived)} onClick={() => { setMenuAnchor(null); setTalkOpenFor(talkContext?.conversationId); }}>Talk</MenuItem>
      </MenuList>
      </Paper>
      </ClickAwayListener>
      </Popper>
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
