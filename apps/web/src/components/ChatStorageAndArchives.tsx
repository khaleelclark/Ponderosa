import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from "@mui/material";
import type { ChatArchivesDto, ChatStorageDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ChatArchiveDialog } from "./ChatArchiveDialog";
import { ChatDeletionDialog } from "./ChatDeletionDialog";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";

const bytes = (size: number | null) => {
  if (size === null) return "Size unavailable";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  return `${(size / 1024 ** 3).toFixed(1)} GiB`;
};

export function ArchivedChats({ onClose, onOpen }: {
  onClose(): void;
  onOpen(chat: ChatArchivesDto["chats"][number]): void;
}): JSX.Element {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["chat-archives"], queryFn: api.listArchivedChats });
  const [resuming, setResuming] = useState<ChatArchivesDto["pendingChats"][number]>();
  const [deleting, setDeleting] = useState<ChatArchivesDto["chats"][number]>();
  const [reviewing, setReviewing] = useState<ChatArchivesDto["heldWork"][number]>();
  const [notice, setNotice] = useState<string>();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["chat-archives"] });
    void client.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all });
    void client.invalidateQueries({ queryKey: queryKeys.conversations.all });
  };
  const restore = useMutation({ mutationFn: api.restoreChat, onSuccess: refresh });
  const remove = useMutation({
    mutationFn: ({ chatId, agentIds }: { chatId: string; agentIds: string[] }) => api.deleteConversation(chatId, agentIds),
    onSuccess: result => {
      if (result.cleanupPending) setNotice("Deletion cleanup is pending.");
      setDeleting(undefined);
      refresh();
    },
  });
  const release = useMutation({
    mutationFn: (item: ChatArchivesDto["heldWork"][number]) => api.releaseArchivedWork(item.chatId, item.id),
    onSuccess: () => { setReviewing(undefined); refresh(); },
  });
  return <>
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Archived Chats</DialogTitle>
      <DialogContent>
        <Stack spacing={2} divider={<Divider />}>
          {query.isPending ? <CircularProgress size={20} aria-label="Loading archived Chats" /> : null}
          {query.error || restore.error ? <Alert severity="error">{(restore.error ?? query.error)?.message}</Alert> : null}
          {notice ? <Alert severity="info">{notice}</Alert> : null}
          {query.data?.pendingChats.map(chat => <Stack key={chat.id} spacing={0.5}>
            <Typography fontWeight={700}>{chat.title}</Typography>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{chat.workingDirectory}</Typography>
            <Alert severity="info" action={<Button color="inherit" onClick={() => setResuming(chat)}>Resume archive</Button>}>
              Archive interrupted. Work is held until cleanup finishes.
            </Alert>
          </Stack>)}
          {query.data?.chats.length === 0 && query.data.pendingChats.length === 0 ? <Typography>No archived Chats.</Typography> : null}
          {query.data?.chats.map(chat => <Stack key={chat.id} spacing={0.5}>
            <Typography fontWeight={700}>{chat.title}</Typography>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{chat.workingDirectory}</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button onClick={() => onOpen(chat)}>Open read-only</Button>
              <Button disabled={restore.isPending} onClick={() => restore.mutate(chat.id)}>Restore</Button>
              <Button color="error" onClick={() => { remove.reset(); setDeleting(chat); }}>Delete permanently</Button>
            </Stack>
          </Stack>)}
          {query.data?.heldWork.length ? <Stack spacing={1}>
            <Typography variant="subtitle1">Held work from restored Chats</Typography>
            {query.data.heldWork.map(item => <Stack key={item.id} direction="row" justifyContent="space-between" alignItems="center">
              <Stack>
                <Typography variant="body2">{item.chatTitle} · {item.agentTitle} · {item.kind.replaceAll("_", " ")} · {new Date(item.createdAt).toLocaleString()}</Typography>
                {item.blocksNewWork ? <Typography variant="body2" color="warning.main">This context transition must finish before the Agent can run new messages.</Typography> : null}
              </Stack>
              <Button onClick={() => { release.reset(); setReviewing(item); }}>Review</Button>
            </Stack>)}
          </Stack> : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
    {resuming ? <ChatArchiveDialog id={resuming.id} title={resuming.title} onClose={() => setResuming(undefined)}
      onArchived={() => { setResuming(undefined); refresh(); }} /> : null}
    <ChatDeletionDialog open={Boolean(deleting)} conversation={deleting} pending={remove.isPending}
      error={remove.error?.message} onClose={() => { if (!remove.isPending) setDeleting(undefined); }}
      onDelete={agentIds => { if (deleting) remove.mutate({ chatId: deleting.id, agentIds }); }} />
    {reviewing ? <Dialog open onClose={() => setReviewing(undefined)} fullWidth maxWidth="xs">
      <DialogTitle>Release held work?</DialogTitle>
      <DialogContent>
        <Typography>{reviewing.agentTitle} in {reviewing.chatTitle} may run this {reviewing.kind.replaceAll("_", " ")} after release.</Typography>
        {reviewing.blocksNewWork ? <Alert severity="warning" sx={{ mt: 1 }}>Releasing this transition can continue the earlier task. New messages for this Agent wait until the transition is resolved.</Alert> : null}
        {reviewing.preview ? <Typography sx={{ my: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{reviewing.preview}</Typography> : null}
        {release.error ? <Alert severity="error">{release.error.message}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button disabled={release.isPending} onClick={() => setReviewing(undefined)}>Keep held</Button>
        <Button disabled={release.isPending} onClick={() => release.mutate(reviewing)}>Release work</Button>
      </DialogActions>
    </Dialog> : null}
  </>;
}

export function ChatStorage({ onClose }: { onClose(): void }): JSX.Element {
  const client = useQueryClient();
  const queryKey = ["chat-storage"];
  const query = useQuery({ queryKey, queryFn: () => api.getChatStorage(), retry: false,
    refetchInterval: current => current.state.status !== "error" && current.state.data?.measuring ? 1000 : false });
  const refresh = useMutation({ mutationFn: () => api.getChatStorage(true),
    onSuccess: result => client.setQueryData(queryKey,result) });
  const [target, setTarget] = useState<ChatStorageDto["folders"][number]>();
  const remove = useMutation({
    mutationFn: api.deleteManagedChatFolder,
    onSuccess: () => {
      setTarget(undefined);
      void client.invalidateQueries({ queryKey: ["chat-storage"] });
    },
  });
  return <>
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Chat Storage</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {query.isPending || query.data?.measuring && !query.error ? <Stack direction="row" spacing={1} alignItems="center" role="status">
            <CircularProgress size={20} /><Typography>Measuring storage…</Typography>
          </Stack> : null}
          {query.error || refresh.error ? <Alert severity="error">{(query.error ?? refresh.error)?.message}</Alert> : null}
          <Typography variant="subtitle1">Managed working folders</Typography>
          {query.data?.folders.map(folder => <Stack key={folder.path} direction="row" alignItems="center" spacing={1}>
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ overflowWrap: "anywhere" }}>{folder.path}</Typography>
              <Typography variant="body2">{bytes(folder.bytes)}{folder.referenced ? " · In use" : ""}</Typography>
            </Stack>
            {folder.referenced ? null : <Button color="error" onClick={() => { remove.reset(); setTarget(folder); }}>Delete folder</Button>}
          </Stack>)}
          <Divider />
          <Typography variant="subtitle1">Project artifacts</Typography>
          {query.data?.projects.map(project => <Typography key={project.id} sx={{ overflowWrap: "anywhere" }}>
            {project.label} · {bytes(project.artifactBytes)}
          </Typography>)}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={query.isFetching || refresh.isPending || Boolean(query.data?.measuring && !query.error)}
          onClick={() => refresh.mutate()}>Refresh sizes</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
    <ResourceDeletionDialog open={Boolean(target)} resourceType="Folder" resourceName={target?.name}
      confirmLabel="Delete folder and its files" pending={remove.isPending} error={remove.error?.message}
      onCancel={() => { if (!remove.isPending) setTarget(undefined); }}
      onConfirm={() => { if (target) remove.mutate(target); }}>
      <Alert severity="warning" sx={{ overflowWrap: "anywhere" }}>This will permanently delete {target?.path} and every file in it.</Alert>
    </ResourceDeletionDialog>
  </>;
}
