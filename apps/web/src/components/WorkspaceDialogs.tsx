import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import type { ConversationDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { TriggerAgentDestination } from "../triggerCreation";
import { queryKeys } from "../queryKeys";
import { DestructiveConfirmDialog, TextInputDialog } from "./ConfirmationDialogs";

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
      <DestructiveConfirmDialog
        open={action?.kind === "delete"}
        title="Delete Project chat?"
        confirmLabel="Delete"
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
        <Typography sx={{ pt: 1 }}>This permanently deletes this Project chat and refuses deletion while an assigned agent is running.</Typography>
      </DestructiveConfirmDialog>
    </>
  );
}

export function HomeCreateDestinationDialog({
  kind,
  projects,
  onClose,
  onContinue,
}: {
  kind?: "chat" | "agent";
  projects: ProjectDto[];
  onClose(): void;
  onContinue(projectId: string): void;
}): JSX.Element {
  const [projectId, setProjectId] = useState("");
  useEffect(() => {
    if (kind) setProjectId("");
  }, [kind]);
  return (
    <Dialog open={Boolean(kind)} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Create {kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : ""}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography color="text.secondary">Choose the Project where this {kind ?? "item"} belongs.</Typography>
          <FormControl fullWidth>
            <InputLabel id="home-create-project-label">Project</InputLabel>
            <Select labelId="home-create-project-label" label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}
            </Select>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button autoFocus variant="contained" disabled={!projectId} onClick={() => onContinue(projectId)}>Continue</Button>
      </DialogActions>
    </Dialog>
  );
}

export function TriggerOwnerDialog({
  open,
  options,
  loading,
  onClose,
  onCreateAgent,
  onContinue,
}: {
  open: boolean;
  options: TriggerAgentDestination[];
  loading: boolean;
  onClose(): void;
  onCreateAgent(): void;
  onContinue(agentId: string): void;
}): JSX.Element {
  const [agentId, setAgentId] = useState("");
  useEffect(() => {
    if (open) setAgentId("");
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Create Trigger</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography color="text.secondary">Choose the Agent that will own and run this Trigger. You will choose its Project chat in the next step.</Typography>
          <FormControl fullWidth>
            <InputLabel id="trigger-create-agent-label">Agent</InputLabel>
            <Select labelId="trigger-create-agent-label" label="Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {options.map(({ project, agent }) => (
                <MenuItem key={agent.id} value={agent.id} disabled={agent.conversationIds.length === 0}>
                  {agent.title} · {project.label}{agent.conversationIds.length === 0 ? " · assign to a Chat first" : ""}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {loading ? <Typography role="status" variant="body2" color="text.secondary">Loading Agents…</Typography> : null}
          {!loading && options.length === 0 ? <Alert severity="info">Create an Agent first, then Ponderosa will continue directly to Trigger setup.</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCreateAgent}>Create New Agent</Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button autoFocus variant="contained" disabled={!agentId} onClick={() => onContinue(agentId)}>Continue</Button>
      </DialogActions>
    </Dialog>
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
