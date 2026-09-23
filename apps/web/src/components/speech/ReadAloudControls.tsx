import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import { Box, Button, IconButton, Tooltip } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES } from "@ponderosa/core";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useWorkspacePreferences } from "../../hooks/queries";
import { speechSynthesisUnavailableReason } from "./browserSpeech";
import { pauseSpeech, releaseSpeechSurface, resumeSpeech, speechSnapshot, startSpeech, stopSpeech, subscribeSpeech } from "./speechCoordinator";
import { speechControlGroupSx, visuallyHiddenSpeechStatusSx } from "./speechStyles";
import { speakableMessageText } from "./speechText";
import { speechSurfaceIsAccessible } from "./speechSurfaceAccessibility";

export function ReadAloudControls({ text }: { text: string }): JSX.Element {
  const ownerId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const state = useSyncExternalStore(subscribeSpeech, speechSnapshot);
  const { data: workspace } = useWorkspacePreferences();
  const preferences = workspace?.speech ?? DEFAULT_SPEECH_PREFERENCES;
  const status = state.ownerId === ownerId ? state.status : "idle";
  const error = state.ownerId === ownerId ? state.error : undefined;
  const unavailable = speechSynthesisUnavailableReason();
  const speakable = speakableMessageText(text);
  useEffect(() => () => releaseSpeechSurface(ownerId), [ownerId]);
  const start = () => {
    if (!speakable || !speechSurfaceIsAccessible(root.current)) return;
    startSpeech(ownerId, speakable, preferences, () => root.current);
  };
  const toggle = () => {
    if (status === "speaking" || status === "loading") pauseSpeech();
    else if (status === "paused") void resumeSpeech();
    else start();
  };
  const running = status === "loading" || status === "speaking" || status === "paused";
  const label = unavailable ?? (status === "paused" ? "Resume read aloud" : running ? "Pause read aloud" : "Read message aloud");
  return <Box ref={root} component="span" sx={speechControlGroupSx}>
    <Tooltip title={label}><span><IconButton size="small" aria-label={label} aria-pressed={running} disabled={Boolean(unavailable) || !speakable} color={running ? "primary" : error ? "error" : "inherit"} onClick={event => { event.stopPropagation(); toggle(); }}>
      {status === "paused" ? <PlayArrowIcon fontSize="inherit" /> : running ? <PauseIcon fontSize="inherit" /> : <VolumeUpIcon fontSize="inherit" />}
    </IconButton></span></Tooltip>
    {running && <Tooltip title="Stop read aloud"><IconButton size="small" aria-label="Stop read aloud" onClick={event => { event.stopPropagation(); stopSpeech(ownerId); }}><StopIcon fontSize="inherit" /></IconButton></Tooltip>}
    <Box component="span" aria-live="polite" role={error ? "alert" : "status"} sx={visuallyHiddenSpeechStatusSx}>{error ?? (status === "speaking" ? "Reading message aloud" : status === "loading" ? "Preparing speech" : status === "paused" ? "Read aloud paused" : status === "stopped" ? "Read aloud stopped" : "")}</Box>
    {error && <Box component="span">
      <Button size="small" onClick={() => start()}>Try again</Button>
    </Box>}
  </Box>;
}
