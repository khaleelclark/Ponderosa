import { Alert, Box, Button, FormControl, InputLabel, LinearProgress, Link, MenuItem, Paper, Select, Stack, Typography } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, SPEECH_PREVIEW_TEXT, SPEECH_VOICES, type SpeechPreferencesDto, type WorkspacePreferencesDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ReadAloudControls } from "./ReadAloudControls";
import { speechCommand, speechStatusKey, useSpeechStatus } from "./speechApi";
import { attachSettingsSpeechSurface, pauseSpeech, resumeSpeech, speechSnapshot, stopSpeech, subscribeSpeech } from "./speechCoordinator";

const bytes = (value?: number) => value === undefined ? "Unavailable" : `${(value / 1024 / 1024).toFixed(1)} MiB`;
export function LocalVoicesSettings({ preferences, onPreferences }: { preferences: WorkspacePreferencesDto; onPreferences(patch: Partial<WorkspacePreferencesDto>): void }): JSX.Element {
  const { data, error: statusError } = useSpeechStatus();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const playback = useSyncExternalStore(subscribeSpeech, speechSnapshot);
  const speech = preferences.speech ?? DEFAULT_SPEECH_PREFERENCES;
  const state = data?.kokoro.state;
  const installing = state === "downloading" || state === "verifying" || state === "installing";
  const ready = state === "ready" || state === "update_available";
  useEffect(() => root.current ? attachSettingsSpeechSurface(root.current) : undefined, []);
  const change = (patch: Partial<SpeechPreferencesDto>) => onPreferences({ speech: { ...speech, ...patch } });
  const command = async (action: Parameters<typeof speechCommand>[0]) => {
    setBusy(true); setError(undefined);
    try {
      if (action === "remove") stopSpeech();
      queryClient.setQueryData(speechStatusKey, await speechCommand(action));
    } catch { setError("The operation could not finish. Refresh voice status and try again."); }
    finally { setBusy(false); }
  };
  return <Paper ref={root} id="local-voices" variant="outlined" sx={{ p: 2.5, scrollMarginTop: 24 }}>
    <Stack spacing={2}>
      <Typography variant="h6" fontWeight={800}>Local voices</Typography>
      <Typography variant="body2">Optional English read-aloud, generated on your Ponderosa host. Text and audio travel only between your browser and that host; no third-party synthesis service is used. Speed depends on the host computer.</Typography>
      <Typography role="status" aria-live="polite">{state ? state.replaceAll("_", " ") : "Loading voice status…"}</Typography>
      {data?.kokoro.reason && <Alert severity="info">{data.kokoro.reason}</Alert>}
      {(error || statusError) && <Alert severity="error">{error ?? "Voice status could not be loaded."}</Alert>}
      <Typography variant="body2">Version: {data?.kokoro.version ?? "Kokoro 1.0 / sherpa-onnx 1.13.8"}<br />{data?.kokoro.packageSource === "host_package" ? "Prepared package" : "Download"}: {bytes(data?.kokoro.downloadBytes)} · Installed estimate: {bytes(data?.kokoro.estimatedInstalledBytes)} · Currently installed: {bytes(data?.kokoro.installedBytes ?? 0)}</Typography>
      {data?.kokoro.packageSource === "host_package" && <Typography variant="caption">The private installation package is prepared on this host. No GitHub credentials are needed by the app. Removing voices keeps that package available for reinstallation.</Typography>}
      <Link href="/api/speech/notices" target="_blank" rel="noopener">Third-party licenses and release qualification</Link>
      {installing && <Box><LinearProgress aria-label="Local voices installation" variant={data?.kokoro.progress?.totalBytes ? "determinate" : "indeterminate"} value={data?.kokoro.progress?.totalBytes ? data.kokoro.progress.completedBytes / data.kokoro.progress.totalBytes * 100 : undefined} /><Typography variant="caption">{bytes(data?.kokoro.progress?.completedBytes)} downloaded</Typography></Box>}
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        {(state === "not_installed" || state === "unsupported") && <Button variant="outlined" disabled={busy || state === "unsupported"} onClick={() => void command("install")}>Install local voices</Button>}
        {state === "repair_required" && <Button disabled={busy} onClick={() => void command("repair")}>Repair local voices</Button>}
        {state === "update_available" && <Button disabled={busy} onClick={() => void command("update")}>Update local voices</Button>}
        {installing && <Button disabled={busy} onClick={() => void command("install/cancel")}>Cancel installation</Button>}
        {(ready || state === "repair_required") && <Button disabled={busy} onClick={() => void command("remove")}>Remove local voices</Button>}
        <Button disabled={busy} onClick={() => void queryClient.invalidateQueries({ queryKey: speechStatusKey })}>Refresh status</Button>
      </Stack>
      <Typography variant="caption">Removing local voices frees their managed files. Browser read-aloud remains available.</Typography>
      <FormControl fullWidth><InputLabel id="speech-engine-label">Read-aloud engine</InputLabel><Select labelId="speech-engine-label" label="Read-aloud engine" value={speech.engine} onChange={event => change({ engine: event.target.value as SpeechPreferencesDto["engine"], engineExplicit: true })}><MenuItem value="browser">Browser / system voice</MenuItem><MenuItem value="kokoro" disabled={!ready}>Local Kokoro voices</MenuItem></Select></FormControl>
      <FormControl fullWidth><InputLabel id="speech-speed-label">Speed</InputLabel><Select labelId="speech-speed-label" label="Speed" value={speech.speed} onChange={event => change({ speed: Number(event.target.value) })}>{[.75, .9, 1, 1.1, 1.25].map(speed => <MenuItem key={speed} value={speed}>{speed}×</MenuItem>)}</Select></FormControl>
      {SPEECH_VOICES.map(voice => <Stack key={voice.id} direction="row" alignItems="center" spacing={1}><Button disabled={!ready} aria-pressed={speech.kokoroVoice === voice.id} onClick={() => change({ kokoroVoice: voice.id })}>{voice.label}{speech.kokoroVoice === voice.id ? " · Selected" : ""}</Button><Typography variant="caption">{voice.language}</Typography>{ready && <Box aria-label={`Preview ${voice.label}`}><ReadAloudControls text={SPEECH_PREVIEW_TEXT} previewPreferences={{ ...speech, kokoroVoice: voice.id }} /></Box>}</Stack>)}
      <Button disabled={busy} onClick={() => void command("clear-cache")}>Clear generated audio cache ({bytes(data?.cacheBytes ?? 0)} in memory)</Button>
      <Typography variant="caption">Generated audio is ephemeral and is not saved to Projects or message history.</Typography>
      {(playback.status === "speaking" || playback.status === "paused" || playback.status === "loading") && <Stack direction="row" spacing={1}><Button onClick={() => playback.status === "paused" ? void resumeSpeech() : pauseSpeech()}>{playback.status === "paused" ? "Resume read aloud" : "Pause read aloud"}</Button><Button onClick={() => stopSpeech()}>Stop read aloud</Button></Stack>}
    </Stack>
  </Paper>;
}
