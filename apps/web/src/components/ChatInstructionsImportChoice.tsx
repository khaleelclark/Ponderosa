import { Alert, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import type { AgentImportChatInstructionsResolution } from "@ponderosa/core";
import { sha256Bytes } from "./idempotentAttempt";

export type ChatInstructionsAction = AgentImportChatInstructionsResolution["action"] | "";
export async function chatInstructionsResolution(action: ChatInstructionsAction, destination: string): Promise<AgentImportChatInstructionsResolution | undefined> {
  if (!action) return undefined;
  const digest = await sha256Bytes(new TextEncoder().encode(destination));
  return { action, expectedDestinationSha256: digest };
}
export function ChatInstructionsImportChoice({ source, destination, value, onChange }: {
  source?: string; destination: string; value: ChatInstructionsAction; onChange(value: ChatInstructionsAction): void;
}): JSX.Element | null {
  if (!source || source === destination) return null;
  if (!destination) return <Alert severity="info">This full copy will restore the source Chat instructions.</Alert>;
  return <Alert severity="warning">
    <Stack spacing={1}>
      <Typography variant="body2">Chat instructions differ · choose which to use after import</Typography>
      <TextField label="Existing Chat Instructions" value={destination} multiline maxRows={3} fullWidth InputProps={{ readOnly: true }} />
      <TextField label="Imported Chat Instructions" value={source} multiline maxRows={3} fullWidth InputProps={{ readOnly: true }} />
      <FormControl fullWidth>
        <InputLabel id="import-chat-instructions-choice">Chat Instructions</InputLabel>
        <Select labelId="import-chat-instructions-choice" label="Chat Instructions" value={value}
          onChange={event => onChange(event.target.value as ChatInstructionsAction)}>
          <MenuItem value="keep_destination">Keep Existing Chat Instructions</MenuItem>
          <MenuItem value="use_source">Use Imported Chat Instructions</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  </Alert>;
}
