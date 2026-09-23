import { Box, Slider, Stack, Typography } from "@mui/material";
import { DEFAULT_SPEECH_PREFERENCES, type WorkspacePreferencesDto } from "@ponderosa/core";
import { useEffect, useState } from "react";

export function BrowserVoiceSettings({ preferences, onPreferences }: {
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
}): JSX.Element {
  const saved = preferences.speech?.speed ?? DEFAULT_SPEECH_PREFERENCES.speed;
  const [speed, setSpeed] = useState(saved);
  useEffect(() => setSpeed(saved), [saved]);
  return <Stack spacing={1}>
    <Typography variant="h6">Browser voice</Typography>
    <Typography variant="body2" color="text.secondary">Read aloud uses your browser’s voice. Dictation uses your device’s speech recognition. Availability depends on your browser and device.</Typography>
    <Box sx={{maxWidth:360,px:1}}>
      <Typography id="browser-speech-speed">Speaking speed</Typography>
      <Slider aria-labelledby="browser-speech-speed" min={.75} max={1.25} step={.05} value={speed}
        valueLabelDisplay="auto" onChange={(_,value)=>setSpeed(value as number)}
        onChangeCommitted={(_,value)=>onPreferences({speech:{speed:value as number}})} />
    </Box>
  </Stack>;
}
