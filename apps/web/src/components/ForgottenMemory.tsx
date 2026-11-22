import { useState } from "react";
import { Alert, Button, Checkbox, FormControlLabel, Stack, Typography } from "@mui/material";
import { useMutation, useQuery } from "@tanstack/react-query";
import { requestJson } from "../api/real";
import { DestructiveConfirmDialog } from "./ConfirmationDialogs";

interface ForgottenEntry { id: string; preview: string }
const endpoint = "/api/local-memory/forgotten";

export function ForgottenMemory({ chatId }: { chatId?: string }): JSX.Element {
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<ForgottenEntry>();
  const [confirmed, setConfirmed] = useState(false);
  const query = useQuery({
    queryKey: ["forgotten-memory", chatId],
    queryFn: () => requestJson<{ items: ForgottenEntry[]; hasMore: boolean }>(
      chatId ? `${endpoint}?chatId=${encodeURIComponent(chatId)}` : endpoint,
    ),
    enabled: opened,
    retry: false,
  });
  const purge = useMutation({
    mutationFn: (id: string) => requestJson<{ deleted: boolean }>(`${endpoint}/purge`, {
      method: "POST",
      body: JSON.stringify({ chatId, id, confirmed: true }),
    }),
    onSuccess: () => { setSelected(undefined); void query.refetch(); },
  });
  return <Stack spacing={1}>
    <Button onClick={() => setOpened(value => !value)}>{opened ? "Hide forgotten memory" : "Show forgotten memory"}</Button>
    {opened && query.isFetching && <Typography role="status">Loading forgotten memory…</Typography>}
    {opened && query.error && <Alert severity="error">{query.error.message}</Alert>}
    {opened && query.data?.items.length === 0 && <Typography>No forgotten entries.</Typography>}
    {opened && query.data?.items.map(entry => <Stack key={entry.id} direction="row" alignItems="center" justifyContent="space-between" gap={1}>
      <Typography sx={{ overflowWrap: "anywhere" }}>{entry.preview || entry.id}</Typography>
      <Button color="error" onClick={() => { purge.reset(); setConfirmed(false); setSelected(entry); }}>Delete permanently</Button>
    </Stack>)}
    {opened && query.data?.hasMore && <Typography>Showing the first 100 forgotten entries.</Typography>}
    <DestructiveConfirmDialog open={Boolean(selected)} title="Delete forgotten memory permanently"
      confirmLabel="Delete permanently" confirmDisabled={!confirmed} pending={purge.isPending}
      error={purge.error?.message} onCancel={() => setSelected(undefined)}
      onConfirm={() => selected && confirmed ? purge.mutateAsync(selected.id).catch(() => undefined) : undefined}>
      <Typography>{selected?.preview}</Typography>
      <Typography paragraph>This removes the saved memory and its index from Ponderosa’s live store. Existing backups and exports may still contain it.</Typography>
      <FormControlLabel label="I understand this cannot be undone" control={<Checkbox checked={confirmed}
        disabled={purge.isPending} onChange={(_, checked) => setConfirmed(checked)} />} />
    </DestructiveConfirmDialog>
  </Stack>;
}
