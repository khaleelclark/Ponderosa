import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import {
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
import { TextInputDialog } from "./ConfirmationDialogs";
import { ChatDeletionDialog } from "./ChatDeletionDialog";

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
    mutationFn: ({ conversation, expectedAgentIds }: { conversation: ConversationDto; expectedAgentIds: string[] }) =>
      api.deleteConversation(conversation.id, expectedAgentIds),
    onSuccess: (_deleted, { conversation }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.project(conversation.projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(conversation.projectId) });
      onDeleted(conversation);
    },
    onError: (_error, { conversation }) => {
      void queryClient.invalidateQueries({ queryKey: ["chat-deletion-agents", conversation.id] });
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
      <ChatDeletionDialog
        open={action?.kind === "delete"}
        conversation={action?.conversation}
        pending={remove.isPending}
        error={remove.isError ? String(remove.error) : undefined}
        onClose={() => {
          remove.reset();
          onClose();
        }}
        onDelete={(expectedAgentIds) => {
          if (action?.kind === "delete") remove.mutate({ conversation: action.conversation, expectedAgentIds });
        }}
      />
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
