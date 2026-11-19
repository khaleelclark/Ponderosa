import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Stack, Typography } from "@mui/material";
import { requestJson } from "../api/real";
import { DestructiveConfirmDialog } from "./ConfirmationDialogs";

interface UnsentFile { id: string; name: string; size: number }
const sizeLabel = (bytes: number) => `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;

export function AttachmentStorage({ id, owner }: { id: string; owner: "agents" | "conversations" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<UnsentFile>();
  const base = `/api/${owner}/${encodeURIComponent(id)}/attachments`;
  const usage = useQuery({ queryKey: ["attachment-storage", owner, id], enabled: open, retry: false,
    queryFn: () => requestJson<{ committed: number; limit: number; unsent: UnsentFile[]; hasMore: boolean }>(`${base}/usage`) });
  const remove = useMutation({
    mutationFn: (file: UnsentFile) => requestJson<void>(`${base}/${encodeURIComponent(file.id)}`, { method: "DELETE" }),
    onSuccess: () => { setSelected(undefined); void usage.refetch(); },
  });
  return <Stack spacing={1}>
    <Button onClick={() => setOpen(value => !value)}>{open ? "Hide attachment storage" : "Attachment storage"}</Button>
    {open && usage.isFetching && <Typography role="status">Reading attachment usage…</Typography>}
    {open && usage.error && <Alert severity="error">{usage.error.message}</Alert>}
    {open && usage.data && <>
      <Typography>{sizeLabel(usage.data.committed)} of {sizeLabel(usage.data.limit)} used</Typography>
      <Typography variant="body2" color="text.secondary">Remove unsent uploads to reclaim space. Sent attachments are part of message history.</Typography>
      {usage.data.unsent.map(file => <Stack key={file.id} direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Typography sx={{ overflowWrap: "anywhere" }}>{file.name} · {sizeLabel(file.size)}</Typography>
        <Button onClick={() => { remove.reset(); setSelected(file); }}>Remove</Button>
      </Stack>)}
      {usage.data.hasMore && <Typography>Remove an unused upload to reveal more.</Typography>}
    </>}
    <DestructiveConfirmDialog open={Boolean(selected)} title="Remove unsent attachment" confirmLabel="Remove attachment"
      pending={remove.isPending} error={remove.error?.message} onCancel={() => setSelected(undefined)}
      onConfirm={() => selected ? remove.mutateAsync(selected).catch(() => undefined) : undefined}>
      <Typography sx={{ overflowWrap: "anywhere" }}>{selected?.name}</Typography>
    </DestructiveConfirmDialog>
  </Stack>;
}
