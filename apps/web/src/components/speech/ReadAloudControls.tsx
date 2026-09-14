import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import { Alert, Box, Button, IconButton, Snackbar, Tooltip } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type SpeechPreferencesDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useWorkspacePreferences, writeWorkspacePreferences } from "../../hooks/queries";
import { speechSynthesisUnavailableReason } from "./browserSpeech";
import { claimSpeechSuggestion, useSpeechStatus } from "./speechApi";
import { handoffSpeechToSettings, pauseSpeech, releaseSpeechSurface, resumeSpeech, speechSnapshot, startSpeech, stopSpeech, subscribeSpeech } from "./speechCoordinator";
import { speechControlGroupSx, visuallyHiddenSpeechStatusSx } from "./speechStyles";
import { speakableMessageText } from "./speechText";
import { speechSurfaceIsAccessible } from "./speechSurfaceAccessibility";

export function openVoiceSettings(preservePlayback = false): void {
  if (preservePlayback) handoffSpeechToSettings();
  window.dispatchEvent(new CustomEvent("ponderosa:voice-settings", { detail: { preservePlayback } }));
}

export function ReadAloudControls({ text, previewPreferences }: { text: string; previewPreferences?: SpeechPreferencesDto }): JSX.Element {
  const ownerId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const state = useSyncExternalStore(subscribeSpeech, speechSnapshot);
  const { data: workspace } = useWorkspacePreferences();
  const { data: capability } = useSpeechStatus();
  const queryClient = useQueryClient();
  const preferences = previewPreferences ?? workspace?.speech ?? DEFAULT_SPEECH_PREFERENCES;
  const localReady = capability && ["ready", "update_available"].includes(capability.kokoro.state);
  const engine = previewPreferences ? "kokoro" : preferences.engine === "kokoro" && localReady ? "kokoro" : "browser";
  const status = state.ownerId === ownerId ? state.status : "idle";
  const error = state.ownerId === ownerId ? state.error : undefined;
  const unavailable = engine === "browser" ? speechSynthesisUnavailableReason() : undefined;
  const speakable = speakableMessageText(text);
  const [suggestion, setSuggestion] = useState(false);
  const [repairNotice, setRepairNotice] = useState(false);
  useEffect(() => () => releaseSpeechSurface(ownerId), [ownerId]);
  useEffect(() => {
    if (capability && !localReady && state.ownerId === ownerId && state.engine === "kokoro") stopSpeech(ownerId);
  }, [capability, localReady, ownerId, state.ownerId, state.engine]);
  const start = (browser = false) => {
    if (!speakable || !speechSurfaceIsAccessible(root.current)) return;
    startSpeech(ownerId, speakable, browser ? "browser" : engine, preferences, () => root.current);
    if (!previewPreferences && !browser && preferences.engine === "kokoro" && engine === "browser") setRepairNotice(true);
    if (!previewPreferences && workspace && engine === "browser" && preferences.localVoiceSuggestion === "unseen") {
      void claimSpeechSuggestion().then(result => {
        if(result.show&&speechSnapshot().ownerId===ownerId&&root.current?.isConnected)setSuggestion(true);
      }).catch(() => {});
    }
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
    <Box component="span" aria-live="polite" role={error ? "alert" : "status"} sx={visuallyHiddenSpeechStatusSx}>{error ?? (status === "speaking" ? "Reading message aloud" : status === "loading" ? "Preparing local speech" : status === "paused" ? "Read aloud paused" : status === "stopped" ? "Read aloud stopped" : "")}</Box>
    {error && <Box component="span">
      {state.engine === "kokoro" && <Button size="small" disabled={Boolean(speechSynthesisUnavailableReason())} onClick={() => start(true)}>Use browser voice</Button>}
      <Button size="small" onClick={() => start()}>Try again</Button>
      <Button size="small" onClick={() => openVoiceSettings()}>Open voice settings</Button>
    </Box>}
    <Snackbar open={suggestion} autoHideDuration={10000} onClose={() => setSuggestion(false)} message="Want a more natural local voice?" action={<>
      <Button color="inherit" onClick={() => {
        setSuggestion(false);
        void writeWorkspacePreferences(queryClient, { speech: { ...preferences, localVoiceSuggestion: "accepted" } }).catch(() => {});
        openVoiceSettings(true);
      }}>Set up local voices</Button><Button color="inherit" onClick={() => setSuggestion(false)}>Not now</Button>
    </>} />
    <Snackbar open={repairNotice} onClose={() => setRepairNotice(false)} autoHideDuration={10000}><Alert severity="info" action={<Button onClick={() => openVoiceSettings(true)}>Voice settings</Button>}>Using browser speech. Local voices are not ready.</Alert></Snackbar>
  </Box>;
}
