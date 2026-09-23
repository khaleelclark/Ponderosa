import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import type { ConversationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ResourceDeletionDialog, TextInputDialog } from "./ConfirmationDialogs";

export type SidebarConversationAction = {
  kind: "rename" | "delete";
  conversation: ConversationDto;
};

export function SidebarConversationDialogs({
  action,
  onClose,
  onRenamed,
  onDeleted,
}: {
  action?: SidebarConversationAction;
  onClose(): void;
  onRenamed(conversation: ConversationDto): void;
  onDeleted(conversation: ConversationDto): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: ({ conversation, title }: { conversation: ConversationDto; title: string }) =>
      api.updateConversation(conversation.id, { title }),
    onSuccess: (_updated, { conversation }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.project(conversation.projectId) });
      onRenamed(conversation);
    },
  });
  const remove = useMutation({
    mutationFn: (conversation: ConversationDto) => api.deleteConversation(conversation.id),
    onSuccess: (_deleted, conversation) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.project(conversation.projectId) });
      onDeleted(conversation);
    },
  });

  return (
    <>
      <TextInputDialog
        open={action?.kind === "rename"}
        title="Rename Chat"
        label="Chat name"
        initialValue={action?.conversation.title ?? ""}
        confirmLabel="Save"
        pendingLabel="Saving…"
        pending={rename.isPending}
        error={rename.isError ? String(rename.error) : undefined}
        validate={(value) => value.trim() ? undefined : "Enter a Chat name."}
        onCancel={() => {
          rename.reset();
          onClose();
        }}
        onConfirm={(title) => {
          if (action?.kind === "rename") rename.mutate({ conversation: action.conversation, title: title.trim() });
        }}
      />
      <ResourceDeletionDialog
        open={action?.kind === "delete"}
        resourceType="Chat"
        resourceName={action?.conversation.title}
        pendingLabel="Deleting…"
        pending={remove.isPending}
        error={remove.isError ? String(remove.error) : undefined}
        onCancel={() => {
          remove.reset();
          onClose();
        }}
        onConfirm={() => {
          if (action?.kind === "delete") remove.mutate(action.conversation);
        }}
      >
        <Alert severity="warning">
          This permanently deletes the Chat and its history. Assigned Agents
          are preserved and become unassigned. Related Automations and pending
          work are cancelled. Stop any active assigned Agent before deleting.
        </Alert>
      </ResourceDeletionDialog>
    </>
  );
}

export function OnboardingCompleteDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>You’re Ready to Build</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center", pt: 1 }}>
          <Box sx={{ width: 56, height: 56, borderRadius: "50%", display: "grid", placeItems: "center", bgcolor: "action.selected", color: "primary.main" }}><CheckCircleOutlineIcon fontSize="large" /></Box>
          <Typography>You’re all set. Have fun prompting, creating Agents, and building organizations.</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button autoFocus variant="contained" onClick={onClose}>Start Prompting</Button>
      </DialogActions>
    </Dialog>
  );
}
