import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from "@mui/material";
import type { ConversationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ResourceSettingsContext } from "./ResourceSettingsContext";
import { ResourceNotificationSettings } from "./ResourceNotificationSettings";

export function ChatContextSettings({ chat, open, onClose }: {
  chat: ConversationDto; open: boolean; onClose(): void;
}) {
  const extension=useContext(ResourceSettingsContext);
  const close=()=>{if(extension.confirmClose?.()!==false)onClose();};
  const [instructions, setInstructions] = useState(chat.instructions ?? "");
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.updateConversation(chat.id, { instructions }),
    onSuccess: async () => {
      await client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(chat.id)});
      close();
    },
  });
  return <Dialog open={open} onClose={save.isPending ? undefined : close} fullWidth maxWidth="sm">
    <DialogTitle>Chat settings</DialogTitle>
    <DialogContent><Stack spacing={2} sx={{pt:1}}>
      <ResourceNotificationSettings kind="conversation" id={chat.id} />
      <TextField label="Instructions" multiline minRows={5} value={instructions}
        onChange={event=>setInstructions(event.target.value)} disabled={save.isPending}
        helperText="Only this Chat and its Agents." />
      {extension.render?.("chat",chat.id)}
      <TextField label="Working folder" value={chat.workingDirectory ?? ""} slotProps={{input:{readOnly:true}}}
        helperText="Working folder · Not a filesystem sandbox." />
      {save.isError ? <Alert severity="error">{String(save.error)}</Alert> : null}
    </Stack></DialogContent>
    <DialogActions><Button onClick={close} disabled={save.isPending}>Cancel</Button>
      <Button onClick={()=>save.mutate()} disabled={save.isPending || instructions.length > 100000}>Save</Button></DialogActions>
  </Dialog>;
}
