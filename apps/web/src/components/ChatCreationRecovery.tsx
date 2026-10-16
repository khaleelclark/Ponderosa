import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConversationDto } from "@ponderosa/core";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ensureCreationAttemptPersisted, readCreationAttempts, saveCreationAttempts, type ChatCreationAttempt } from "./chatCreationAttempts";

/** Recovery is available after healthy direct entry too, without delaying it or
 * replaying an opening message. The ordinary workspace header owns this slot. */
export function ChatCreationRecovery({ activeCreationKey, onCreated }: {
  activeCreationKey?: string;
  onCreated(projectId: string, conversationId: string): void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [attempts] = useState(readCreationAttempts);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const retained = attempts.filter(item => item.key !== activeCreationKey && !item.chat);
  const reveal = (chat: Pick<ConversationDto, "id" | "projectId">) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all }).catch(() => {});
    if (mounted.current) onCreated(chat.projectId, chat.id);
  };
  const recover = async (attempt: ChatCreationAttempt) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try {
      if (!ensureCreationAttemptPersisted(attempt)) {
        throw new Error("Browser storage is unavailable. The original attempt is retained; enable storage before retrying.");
      }
      const chat = await api.createChat(attempt.input, attempt.key);
      // Keep completed exact identities for old history/settings return URLs.
      const journal = readCreationAttempts();
      if (!saveCreationAttempts([...journal.filter(item => item.key !== attempt.key),
        { ...attempt, chat: { id: chat.id, projectId: chat.projectId } }])) {
        throw new Error("Chat was saved, but its local receipt could not be saved. The original attempt is kept for exact retry.");
      }
      reveal(chat);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!retained.length) return null;
  return <>
    <Button size="small" onClick={() => setOpen(true)}>Recover earlier Chat</Button>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>Recover earlier Chat</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {retained.map(item => <Button key={item.key} disabled={busy}
            onClick={() => void recover(item)}>Open unconfirmed Chat: {item.input.label}</Button>)}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
