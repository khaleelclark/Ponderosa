import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from "@mui/material";
import type { ConversationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ResourceNotificationSettings } from "./ResourceNotificationSettings";

export function ChatContextSettings({ chat, open, onClose }: {
  chat: ConversationDto; open: boolean; onClose(): void;
}) {
  const [instructions, setInstructions] = useState(chat.instructions ?? "");
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.updateConversation(chat.id, { instructions }),
    onSuccess: async () => {
      await client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(chat.id)});
      onClose();
    },
  });
  return <Dialog open={open} onClose={save.isPending ? undefined : onClose} fullWidth maxWidth="sm">
    <DialogTitle>Chat settings</DialogTitle>
    <DialogContent><Stack spacing={2} sx={{pt:1}}>
      <ResourceNotificationSettings kind="conversation" id={chat.id} />
      <TextField label="Instructions" multiline minRows={5} value={instructions}
        onChange={event=>setInstructions(event.target.value)} disabled={save.isPending}
        helperText="Applies to this chat and its agents only. Folder membership does not share these instructions." />
      <TextField label="Working folder" value={chat.workingDirectory ?? ""} slotProps={{input:{readOnly:true}}}
        helperText="Existing working-folder associations are preserved. This is not a filesystem sandbox." />
      {save.isError ? <Alert severity="error">{String(save.error)}</Alert> : null}
    </Stack></DialogContent>
    <DialogActions><Button onClick={onClose} disabled={save.isPending}>Cancel</Button>
      <Button onClick={()=>save.mutate()} disabled={save.isPending || instructions.length > 100000}>Save</Button></DialogActions>
  </Dialog>;
}
