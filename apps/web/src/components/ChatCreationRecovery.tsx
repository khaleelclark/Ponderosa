import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from "@mui/material";
import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConversationDto } from "@ponderosa/core";
import { queryKeys } from "../queryKeys";
import { ensureCreationAttemptPersisted, mayRecordCreationReceipt, mayRetryCreationAttempt, readCreationAttempts, readDurableChatAttempts, saveCreationAttempts, sameCreationAttempt, sameCreationOwner, submitCreationAttempt, type ChatCreationAttempt, type ChatCreationOwner } from "./chatCreationAttempts";

/** Recovery is available after healthy direct entry too, without delaying it or
 * replaying an opening message. The ordinary workspace header owns this slot. */
export function ChatCreationRecovery({ activeCreationKey, owner, importOnly = false, onCreated }: {
  activeCreationKey?: string;
  owner?: ChatCreationOwner;
  importOnly?: boolean;
  onCreated(projectId: string, conversationId: string): void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [attempts] = useState(readCreationAttempts);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const retained = attempts.filter(item => sameCreationOwner(item.owner,owner) && item.key !== activeCreationKey && !item.chat && (!importOnly || item.origin === "import_destination"));
  const reveal = (chat: Pick<ConversationDto, "id" | "projectId">) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }).catch(() => {});
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all }).catch(() => {});
    if (mounted.current) onCreated(chat.projectId, chat.id);
  };
  const recover = async (attempt: ChatCreationAttempt) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try {
      if (!mayRetryCreationAttempt(readDurableChatAttempts(), attempt))
        throw new Error("Saved destination information is unavailable or changed. The original request is preserved.");
      if (!ensureCreationAttemptPersisted(attempt)) {
        throw new Error("Browser storage is unavailable. The original attempt is retained; enable storage before retrying.");
      }
      const chat = await submitCreationAttempt(attempt);
      if (attempt.origin === "import_destination" && (!chat.id || !chat.projectId ||
          (attempt.owner ? chat.branchId !== attempt.owner.branchId || Boolean(chat.executionId) : Boolean(chat.branchId)))) {
        throw new Error("Destination receipt does not match the requested product and workflow. The original request is retained.");
      }
      // Keep completed exact identities for old history/settings return URLs.
      const journal = readDurableChatAttempts();
      if (!mayRecordCreationReceipt(journal, attempt, chat)) {
        throw new Error("Destination receipt conflicts with saved information. The original evidence is retained.");
      }
      if (!saveCreationAttempts([...journal.filter(item => !sameCreationAttempt(item, attempt)),
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
    <Button size="small" onClick={() => setOpen(true)}>{importOnly ? "Recover Import Destination" : "Recover Earlier Chat"}</Button>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>Recover Earlier Chat</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {retained.map(item => <Button key={item.key} disabled={busy}
            onClick={() => void recover(item)}>Open Unconfirmed Chat: {item.input.label}</Button>)}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
