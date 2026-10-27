import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import PhoneIcon from "@mui/icons-material/Phone";
import MicNoneIcon from "@mui/icons-material/MicNone";
import StopIcon from "@mui/icons-material/Stop";
import { Box, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import { useEffect, useId, useRef, useState } from "react";
import {
  speechControlGroupSx,
  speechStatusSx,
  visuallyHiddenSpeechStatusSx,
} from "./speechStyles";
import { useWorkspaceReadOnly } from "../WorkspaceReadOnlyContext";
import { useDictation } from "./useDictation";
import { VoiceConversation, type VoiceConversationContext } from "./VoiceConversation";

export function DictationControls({
  disabled: suppliedDisabled,
  voiceContext,
  onFinalTranscript,
  onSettlingChange,
  onActiveChange,
}: {
  disabled: boolean;
  voiceContext?: VoiceConversationContext;
  onFinalTranscript(transcript: string): void;
  onSettlingChange(settling: boolean): void;
  onActiveChange?(active: boolean): void;
}): JSX.Element {
  const disabled = useWorkspaceReadOnly() || suppliedDisabled;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasCallOpen = useRef(false);
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const callOwner = JSON.stringify([voiceContext?.projectId, voiceContext?.conversationId, voiceContext?.selectedAgentId, voiceContext?.lockAgent]);
  const [openedCallOwner, setOpenedCallOwner] = useState<string>();
  const callOpen = openedCallOwner === callOwner;
  useEffect(() => { setOpenedCallOwner(undefined); }, [callOwner]);
  useEffect(() => {
    if (disabled) { setAnchor(null); setOpenedCallOwner(undefined); }
  }, [disabled]);
  useEffect(() => {
    if (wasCallOpen.current && !callOpen) buttonRef.current?.focus({preventScroll: true});
    wasCallOpen.current = callOpen;
  }, [callOpen]);
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
    onActiveChange?.(active || paused);
  }, [active, paused, onActiveChange]);
  const busy = dictation.status === "pausing" || dictation.status === "stopping";
  const canStopForDisabled =
    dictation.status === "starting" ||
    dictation.status === "listening" ||
    paused;

  useEffect(() => {
    if (disabled && canStopForDisabled) dictation.stop();
  }, [canStopForDisabled, dictation.stop, disabled]);

  const unavailable = dictation.unavailableReason;
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
      <Tooltip title="Voice options">
        <span>
          <IconButton
            ref={buttonRef}
            color={active || paused ? "primary" : "inherit"}
            aria-label="Voice options"
            aria-haspopup="menu"
            aria-expanded={Boolean(anchor)}
            aria-controls={anchor ? menuId : undefined}
            disabled={disabled || callOpen}
            onClick={event => setAnchor(event.currentTarget)}
          >
            <GraphicEqIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor) && !disabled}
        onClose={() => setAnchor(null)}
        // Keep the dictation surface accessible while its own menu is open.
        container={rootRef.current}
        MenuListProps={{"aria-label": "Voice options"}}
        disableRestoreFocus={callOpen}
        disableScrollLock
      >
        <MenuItem
          disabled={!anchor || disabled || active || paused || !voiceContext || !voiceContext.agents.some(agent =>
            agent.projectId === voiceContext.projectId && agent.conversationId === voiceContext.conversationId &&
            (!voiceContext.selectedAgentId || agent.id === voiceContext.selectedAgentId))}
          onClick={() => { if (!anchor) return; setAnchor(null); setOpenedCallOwner(callOwner); }}
        >
          <ListItemIcon><PhoneIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Voice call" secondary={active || paused ? "Stop dictation first" : !voiceContext ? "Choose a source Chat and Agent" : undefined} />
        </MenuItem>
        <MenuItem
          disabled={!anchor || disabled || Boolean(unavailable) || busy}
          onClick={() => {
            if (!anchor) return;
            setAnchor(null);
            if (dictation.status === "listening" || dictation.status === "starting") dictation.pause();
            else if (paused) dictation.resume();
            else dictation.start();
          }}
        >
          <ListItemIcon><MicNoneIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Dictation" secondary={unavailable ?? (active || paused ? primaryLabel : undefined)} />
        </MenuItem>
      </Menu>
      {voiceContext && callOpen && !disabled && <VoiceConversation {...voiceContext} open onClose={() => setOpenedCallOwner(undefined)} />}
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
