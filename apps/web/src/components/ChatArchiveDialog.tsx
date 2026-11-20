import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";

export function ChatArchiveDialog({ id, title, onClose, onArchived }: {
  id: string;
  title: string;
  onClose(): void;
  onArchived(): void;
}): JSX.Element {
  const client = useQueryClient();
  const preview = useQuery({ queryKey: ["chat-archive-preview", id], queryFn: () => api.previewChatArchive(id), staleTime: 0 });
  const archive = useMutation({
    mutationFn: () => api.archiveChat(id, preview.data!.activeRuns.map(run => run.runId)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all });
      void client.invalidateQueries({ queryKey: queryKeys.conversations.all });
      void client.invalidateQueries({ queryKey: ["chat-archives"] });
      onArchived();
    },
    onError: () => { void preview.refetch(); },
  });
  const runs = preview.data?.activeRuns ?? [];
  return <Dialog open onClose={archive.isPending ? undefined : onClose} fullWidth maxWidth="xs">
    <DialogTitle>{preview.data?.pending ? `Resume archive for ${title}?` : `Archive ${title}?`}</DialogTitle>
    <DialogContent>
      <Stack spacing={1.5}>
        <Typography>You can restore this Chat from Archived Chats. Its history, Agents, and files will be kept.</Typography>
        {preview.data?.workingDirectory ? <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
          Working folder: {preview.data.workingDirectory}
        </Typography> : null}
        {preview.data?.pending ? <Alert severity="info">An earlier archive was interrupted. Resume it to verify Run and provider cleanup.</Alert> : null}
        {runs.length ? <Alert severity="warning">These Agents have active Runs that will be stopped before archiving: {runs.map(run => run.title).join(", ")}.</Alert> : null}
        {preview.isPending ? <CircularProgress size={20} aria-label="Checking active Runs" /> : null}
        {preview.error || archive.error ? <Alert severity="error">{(archive.error ?? preview.error)?.message}</Alert> : null}
      </Stack>
    </DialogContent>
    <DialogActions>
      <Button disabled={archive.isPending} onClick={onClose}>Cancel</Button>
      <Button variant="contained" disabled={!preview.data || preview.isFetching || archive.isPending} onClick={() => archive.mutate()}>
        {archive.isPending ? "Archiving…" : runs.length ? "Stop and archive" : preview.data?.pending ? "Resume archive" : "Archive"}
      </Button>
    </DialogActions>
  </Dialog>;
}
