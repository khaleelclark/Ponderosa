import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
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
        title="Rename Project chat"
        label="Project chat name"
        initialValue={action?.conversation.title ?? ""}
        confirmLabel="Save"
        pendingLabel="Saving…"
        pending={rename.isPending}
        error={rename.isError ? String(rename.error) : undefined}
        validate={(value) => value.trim() ? undefined : "Enter a Project chat name."}
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
  onOpenWiki,
}: {
  open: boolean;
  onClose(): void;
  onOpenWiki(): void;
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>You’re Ready to Build</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center", pt: 1 }}>
          <Box sx={{ width: 56, height: 56, borderRadius: "50%", display: "grid", placeItems: "center", bgcolor: "action.selected", color: "primary.main" }}><MenuBookOutlinedIcon fontSize="large" /></Box>
          <Typography>You’re all set. Have fun prompting, creating Agents, and building organizations.</Typography>
          <Alert severity="info" icon={<MenuBookOutlinedIcon />}>Need help? Open the Wiki anytime using the book icon in the sidebar.</Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<MenuBookOutlinedIcon />} onClick={onOpenWiki}>Open Wiki</Button>
        <Button autoFocus variant="contained" onClick={onClose}>Start Prompting</Button>
      </DialogActions>
    </Dialog>
  );
}
