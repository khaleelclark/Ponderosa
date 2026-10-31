import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import type { ConversationDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";

export function ChatDeletionDialog({
  open,
  conversation,
  pending,
  error,
  onClose,
  onDelete,
}: {
  open: boolean;
  conversation?: ConversationDto;
  pending: boolean;
  error?: string;
  onClose(): void;
  onDelete(expectedAgentIds: string[]): void;
}): JSX.Element {
  const agentsQuery = useQuery({
    queryKey: ["chat-deletion-agents", conversation?.id],
    queryFn: () => api.listConversationMembers(conversation!.id),
    enabled: open && Boolean(conversation) && !conversation?.branchId,
    staleTime: 0,
    retry: false,
  });
  const agents = [...(agentsQuery.data ?? [])].sort((a, b) =>
    a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  if (conversation?.branchId) return <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
    <DialogTitle>Workflow-owned Chat</DialogTitle>
    <DialogContent>
      <Typography>This Chat belongs to a workflow and cannot be deleted separately. To remove it, open workflow settings and review deleting the entire workflow, including its other Chats and Agents.</Typography>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Cancel</Button>
      <Button href={`/branches?branch=${encodeURIComponent(conversation.branchId)}&tab=settings`}>Open workflow settings</Button>
    </DialogActions>
  </Dialog>;

  return <ResourceDeletionDialog
    open={open}
    resourceType="Chat"
    resourceName={conversation?.title}
    pendingLabel="Deleting…"
    pending={pending}
    error={error}
    confirmDisabled={!agentsQuery.data || agentsQuery.isFetching || agentsQuery.isError}
    onCancel={onClose}
    onConfirm={() => onDelete(agents.map(agent => agent.id))}
  >
    <Alert severity="warning">
      This permanently deletes the Chat and its history{agents.length ? ", plus the Agents listed below" : ""}.
      {agents.length ? " Their runs, work logs, private attachments, and in-app artifact views will no longer be available." : ""}
      Files saved in the Project working folder and Project-level artifacts are not deleted.
      Pending work is cancelled. Stop active Agents before deleting.
    </Alert>
    {agentsQuery.isFetching ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1.5 }}>
      <CircularProgress size={18} />
      <Typography variant="body2">Checking assigned Agents…</Typography>
    </Stack> : null}
    {agentsQuery.isError ? <Alert severity="error" sx={{ mt: 1.5 }}>
      Could not check which Agents this Chat owns. Try again before deleting.
    </Alert> : null}
    {agentsQuery.data ? <>
      <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
        Agents that will be deleted ({agents.length})
      </Typography>
      {agents.length ? <Box component="ul" sx={{ maxHeight: 180, overflowY: "auto", mt: 0, mb: 0, pl: 2.5 }}>
        {agents.map(agent => <Typography component="li" variant="body2" key={agent.id}>
          {agent.title}{agent.handle ? <Typography component="span" variant="body2" color="text.secondary"> · #{agent.handle}</Typography> : null}
        </Typography>)}
      </Box> : <Typography variant="body2" color="text.secondary">No Agents are assigned to this Chat.</Typography>}
    </> : null}
  </ResourceDeletionDialog>;
}
