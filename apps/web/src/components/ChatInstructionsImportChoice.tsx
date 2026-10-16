import { Alert, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import type { AgentImportChatInstructionsResolution } from "@ponderosa/core";

export type ChatInstructionsAction = AgentImportChatInstructionsResolution["action"] | "";
export async function chatInstructionsResolution(action: ChatInstructionsAction, destination: string): Promise<AgentImportChatInstructionsResolution | undefined> {
  if (!action) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(destination));
  return { action, expectedDestinationSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
}
export function ChatInstructionsImportChoice({ source, destination, value, onChange }: {
  source?: string; destination: string; value: ChatInstructionsAction; onChange(value: ChatInstructionsAction): void;
}): JSX.Element | null {
  if (!source || source === destination) return null;
  if (!destination) return <Alert severity="info">This full copy will restore the source Chat instructions.</Alert>;
  return <Alert severity="warning">
    <Stack spacing={1}>
      <Typography variant="body2">This Chat has different instructions. Choose which instructions it should use after importing.</Typography>
      <TextField label="Existing Chat instructions" value={destination} multiline maxRows={3} fullWidth InputProps={{ readOnly: true }} />
      <TextField label="Imported Chat instructions" value={source} multiline maxRows={3} fullWidth InputProps={{ readOnly: true }} />
      <FormControl fullWidth>
        <InputLabel id="import-chat-instructions-choice">Chat instructions</InputLabel>
        <Select labelId="import-chat-instructions-choice" label="Chat instructions" value={value}
          onChange={event => onChange(event.target.value as ChatInstructionsAction)}>
          <MenuItem value="keep_destination">Keep existing Chat instructions</MenuItem>
          <MenuItem value="use_source">Use imported Chat instructions</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  </Alert>;
}
