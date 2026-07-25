import {
  Alert,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { DestructiveConfirmDialog } from "./ConfirmationDialogs";

export function AgentDeletionDialog({
  open,
  projectId,
  rootAgentIds,
  title = "Delete agent?",
  confirmationText,
  onClose,
  onDeleted,
}: {
  open: boolean;
  projectId: string;
  rootAgentIds: string[];
  title?: string;
  confirmationText?: string;
  onClose(): void;
  onDeleted(deletedAgentIds: string[]): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const roots = useMemo(() => [...new Set(rootAgentIds)].sort(), [rootAgentIds]);
  const rootsKey = roots.join(",");
  const [confirmation, setConfirmation] = useState("");
  const preview = useQuery({
    queryKey: queryKeys.agentDeletionPreview.detail(projectId, rootsKey),
    queryFn: () => api.previewAgentDeletion(projectId, { rootAgentIds: roots }),
    enabled: open && roots.length > 0,
    retry: false,
  });
  const deletion = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("Deletion preview is unavailable");
      return api.commitAgentDeletion(projectId, {
        rootAgentIds: preview.data.rootAgentIds,
        previewHash: preview.data.previewHash,
      });
    },
    onSuccess: async (result) => {
      result.deletedAgentIds.forEach((agentId) => queryClient.removeQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collaborationAll }),
      ]);
      onDeleted(result.deletedAgentIds);
    },
    onError: async () => {
      // A 409 means the confirmed cascade changed. Always obtain a fresh
      // server preview before the operator can try again.
      await preview.refetch();
      setConfirmation("");
    },
  });

  useEffect(() => {
    if (!open) return;
    setConfirmation("");
    deletion.reset();
  // Reset only when the dialog represents a new confirmation surface.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, rootsKey]);

  const affected = preview.data?.affectedAgents ?? [];
  const shown = affected.slice(0, 8);
  const confirmed = !confirmationText || confirmation === confirmationText;
  const close = () => {
    if (deletion.isPending) return;
    onClose();
  };

  return (
    <DestructiveConfirmDialog
      open={open}
      title={title}
      pending={deletion.isPending}
      pendingLabel="Deleting"
      error={deletion.isError
        ? <>{String(deletion.error)} The organization was checked again; review the current list before retrying.</>
        : undefined}
      confirmDisabled={!preview.data || !confirmed}
      onCancel={close}
      onConfirm={() => deletion.mutate()}
    >
      {preview.isLoading ? <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}><CircularProgress size={20} /><Typography variant="body2">Checking the current organization…</Typography></Stack> : null}
      {preview.isError ? <Alert severity="error">{String(preview.error)}</Alert> : null}
      {preview.data ? <>
        <Alert severity="error" sx={{ mb: 2 }}>
          This permanently deletes {affected.length} server-verified Agent {affected.length === 1 ? "identity" : "identities"}, including runs, work logs, private attachments, and descendants. Active work is cancelled. Project artifacts and Project-chat history remain intact.
        </Alert>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Agents that will be deleted</Typography>
        <Stack spacing={0.25} sx={{ mb: confirmationText ? 2 : 0 }}>
          {shown.map((agent) => <Typography key={agent.id} variant="body2">• {agent.title}</Typography>)}
          {affected.length > shown.length ? <Typography variant="body2" color="text.secondary">and {affected.length - shown.length} more</Typography> : null}
        </Stack>
        {confirmationText ? <TextField
          fullWidth
          label={`Type ${confirmationText}`}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        /> : null}
      </> : null}
    </DestructiveConfirmDialog>
  );
}
