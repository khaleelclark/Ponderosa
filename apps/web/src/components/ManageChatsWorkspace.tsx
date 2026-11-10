import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  AgentDto,
  WorkspaceConversationDirectoryItemDto,
} from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useManagedWorkspaceCollection } from "../hooks/useManagedWorkspaceCollection";
import {
  useWorkspaceDirectory,
} from "../hooks/useWorkspaceDirectory";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import {
  CollectionStateFeedback,
  CollectionToolbar,
  CollectionWorkspace,
} from "./CollectionPrimitives";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";
import { useMutationNotification } from "./MutationNotifications";

type ChatRow = WorkspaceConversationDirectoryItemDto;
const chatRowId = (row: ChatRow) => row.conversation.id;

interface ChatDeletionPreview {
  row: ChatRow;
  agents: AgentDto[];
}

interface ChatDeletionFailure {
  preview: ChatDeletionPreview;
  message: string;
}

interface ChatDeletionPresentation {
  count: number;
  previews?: ChatDeletionPreview[];
  loading: boolean;
  queryFailed: boolean;
  failures: ChatDeletionFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ManageChatsWorkspace({
  onNavigate,
}: {
  onNavigate(route: Route): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const notify = useMutationNotification();
  const [search, setSearch] = useState("");
  // Retained data only renders the closing Dialog; actual targets clear immediately.
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; retained?: ChatDeletionPresentation }>({ open: false });
  const deleteOpen = deleteDialog.open;
  const [deleteTargets, setDeleteTargets] = useState<ChatRow[]>([]);
  const [deleteFailures, setDeleteFailures] = useState<ChatDeletionFailure[]>(
    [],
  );
  const [deleteProgress, setDeleteProgress] = useState({ completed: 0, total: 0 });

  const directoryQuery =
    useWorkspaceDirectory<WorkspaceConversationDirectoryItemDto>(
      "conversation",
      { search },
    );
  const {
    rows, total, selected, setSelected, visibleSelectedCount,
    allVisibleSelected, collectionComplete, toggleSelected, toggleSelectAll,
  } = useManagedWorkspaceCollection(directoryQuery, chatRowId);

  const previewQuery = useQuery({
    queryKey: [
      "bulk-chat-deletion-preview",
      deleteTargets.map(row => row.conversation.id).sort().join(","),
    ],
    queryFn: async (): Promise<ChatDeletionPreview[]> => {
      const previews: ChatDeletionPreview[] = [];
      // Avoid opening an unbounded burst of requests when Select all is used.
      for (const row of deleteTargets) {
        previews.push({
          row,
          agents: await api.listConversationMembers(row.conversation.id),
        });
      }
      return previews;
    },
    enabled: deleteOpen && deleteTargets.length > 0,
    staleTime: 0,
    retry: false,
  });

  const activeDeletionPresentation: ChatDeletionPresentation = {
    count: deleteTargets.length, previews: previewQuery.data,
    loading: previewQuery.isFetching, queryFailed: previewQuery.isError, failures: deleteFailures,
  };
  const deletionPresentation = deleteOpen ? activeDeletionPresentation : deleteDialog.retained;
  const finishDeleteDialog = () => {
    setDeleteDialog({ open: false, retained: activeDeletionPresentation });
    setDeleteTargets([]);
  };

  const remove = useMutation({
    mutationFn: async (
      previews: ChatDeletionPreview[],
    ): Promise<{
      deleted: ChatDeletionPreview[];
      pending: ChatDeletionPreview[];
      cleanupPending: ChatDeletionPreview[];
      failures: ChatDeletionFailure[];
    }> => {
      const deleted: ChatDeletionPreview[] = [];
      const pending: ChatDeletionPreview[] = [];
      const cleanupPending: ChatDeletionPreview[] = [];
      const failures: ChatDeletionFailure[] = [];
      setDeleteProgress({ completed: 0, total: previews.length });
      for (const preview of previews) {
        try {
          const result = await api.deleteConversation(
            preview.row.conversation.id,
            preview.agents.map(agent => agent.id),
          );
          if (result.deleted) {
            deleted.push(preview);
            if (result.cleanupPending) cleanupPending.push(preview);
          } else pending.push(preview);
        } catch (error) {
          failures.push({ preview, message: errorMessage(error) });
        }
        setDeleteProgress(current => ({
          ...current,
          completed: current.completed + 1,
        }));
      }
      return { deleted, pending, cleanupPending, failures };
    },
    onSuccess: ({ deleted, pending, cleanupPending, failures }) => {
      if (pending.length) notify({
        message: `${pending.length} Chat deletion${pending.length === 1 ? " is" : "s are"} still pending. The Chat${pending.length === 1 ? "" : "s"} may still be present.`,
        severity: "warning", persistent: true, key: `bulk-chat-deletion:${pending.map(item => item.row.conversation.id).sort().join(",")}`,
      });
      if (cleanupPending.length) notify({
        message: `${cleanupPending.length} Chat${cleanupPending.length === 1 ? " was" : "s were"} removed, but cleanup is pending. Saved data, including memory, may remain.`,
        severity: "warning", persistent: true, key: `bulk-chat-cleanup:${cleanupPending.map(item => item.row.conversation.id).sort().join(",")}`,
      });
      const projectIds = new Set(deleted.map(item => item.row.project.id));
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDirectory.kind("conversation"),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll });
      projectIds.forEach(projectId => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.conversations.project(projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.agents.project(projectId),
        });
      });
      setSelected(current => {
        const next = new Map(current);
        deleted.forEach(item => next.delete(item.row.conversation.id));
        return next;
      });
      setDeleteFailures(failures);
      if (failures.length) {
        setDeleteTargets(failures.map(failure => failure.preview.row));
        return;
      }
      finishDeleteDialog();
    },
  });

  const openDelete = () => {
    const targets = [...selected.values()];
    if (!targets.length) return;
    setDeleteFailures([]);
    setDeleteProgress({ completed: 0, total: targets.length });
    setDeleteTargets(targets);
    setDeleteDialog({ open: true });
  };
  const closeDelete = () => {
    if (!deleteOpen || remove.isPending) return;
    finishDeleteDialog();
    setDeleteFailures([]);
    remove.reset();
  };

  const previewAgents = deletionPresentation?.previews?.flatMap(preview =>
    preview.agents.map(agent => ({
      agent,
      chatTitle: preview.row.conversation.title,
    })),
  ) ?? [];
  const deleteError = deletionPresentation?.queryFailed
    ? "Ponderosa could not verify every affected Agent. Try again before deleting."
    : deletionPresentation?.failures.length
      ? <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
          {deletionPresentation.failures.map(failure => (
            <Typography component="li" variant="body2" key={failure.preview.row.conversation.id}>
              {failure.preview.row.conversation.title}: {failure.message}
            </Typography>
          ))}
        </Stack>
      : undefined;

  return <>
    <CollectionWorkspace
      icon={<ChatBubbleOutlineIcon />}
      title="Manage Chats"
      detail={directoryQuery.requestState.hasResolved
        ? `${total} ${total === 1 ? "Chat" : "Chats"} across Ponderosa`
        : undefined}
      primaryAction={
        <Button
          color="error"
          variant="contained"
          startIcon={<DeleteOutlineIcon />}
          disabled={!selected.size}
          onClick={openDelete}
        >
          {selected.size ? `Delete Selected (${selected.size})` : "Delete Selected"}
        </Button>
      }
      compactPrimaryAction={
        <Tooltip title={selected.size ? `Delete ${selected.size} Selected Chats` : "Select Chats To Delete"}>
          <span>
            <IconButton
              color="error"
              aria-label={selected.size ? `Delete ${selected.size} Selected Chats` : "Delete Selected Chats"}
              disabled={!selected.size}
              onClick={openDelete}
            >
              <DeleteOutlineIcon />
            </IconButton>
          </span>
        </Tooltip>
      }
      toolbar={
        <CollectionToolbar
          search={search}
          onSearch={setSearch}
          searchLabel="Search Chats To Manage"
        >
          <Stack
            data-collection-toolbar-actions
            direction="row"
            spacing={1}
            sx={{ alignItems: "center", minWidth: 0, flexWrap: "wrap" }}
          >
            <Button
              color="inherit"
              size="small"
              disabled={!collectionComplete || !rows.length}
              onClick={toggleSelectAll}
              startIcon={
                <Checkbox
                  tabIndex={-1}
                  checked={allVisibleSelected}
                  indeterminate={visibleSelectedCount > 0 && !allVisibleSelected}
                  disableRipple
                  size="small"
                  inputProps={{ "aria-hidden": true }}
                  sx={{ p: 0 }}
                />
              }
            >
              Select All
            </Button>
            <Typography variant="body2" color="text.secondary" noWrap>
              {directoryQuery.requestState.hasNextPage || directoryQuery.requestState.isFetchingNextPage
                ? "Loading all Chats…"
                : `${selected.size} selected`}
            </Typography>
            {selected.size ? (
              <Button color="inherit" size="small" onClick={() => setSelected(new Map())}>
                Clear
              </Button>
            ) : null}
          </Stack>
        </CollectionToolbar>
      }
      listLabel="Chats Available For Bulk Management"
      busy={
        directoryQuery.requestState.isInitialLoading ||
        directoryQuery.requestState.isRefreshing ||
        directoryQuery.requestState.isFetchingNextPage
      }
    >
      {rows.map(row => {
        const checked = selected.has(row.conversation.id);
        return <Paper
          key={row.conversation.id}
          variant="outlined"
          sx={{
            display: "flex",
            alignItems: "center",
            minWidth: 0,
            px: 1,
            py: 0.5,
            borderColor: checked ? "primary.main" : undefined,
            bgcolor: checked ? "action.selected" : undefined,
          }}
        >
          <Checkbox
            checked={checked}
            onChange={() => toggleSelected(row)}
            inputProps={{ "aria-label": `Select ${row.conversation.title}` }}
          />
          <Box sx={{ minWidth: 0, flex: 1, py: 0.5 }}>
            <Typography noWrap fontWeight={700}>{row.conversation.title}</Typography>
            <Typography noWrap variant="caption" color="text.secondary">
              {row.project.label}
            </Typography>
          </Box>
          <Tooltip title={`Open ${row.conversation.title}`}>
            <IconButton
              aria-label={`Open ${row.conversation.title}`}
              onClick={() => onNavigate({
                kind: "conversation",
                projectId: row.project.id,
                conversationId: row.conversation.id,
              })}
            >
              <ArrowForwardIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Paper>;
      })}
      <CollectionStateFeedback
        request={directoryQuery.requestState}
        itemCount={rows.length}
        filtersActive={Boolean(search.trim())}
        resourceLabel="Chats"
        emptyTitle="No Chats Yet"
        emptyDetail="There are no Chats to manage."
        noMatchTitle="No Chats match this search"
        noMatchDetail="Try a different search."
        onClearFilters={() => setSearch("")}
      />
    </CollectionWorkspace>

    <ResourceDeletionDialog
      open={deleteOpen}
      resourceType="Chats"
      title={`Delete ${deletionPresentation?.count ?? 0} selected ${deletionPresentation?.count === 1 ? "Chat" : "Chats"}?`}
      confirmLabel={`Delete ${deletionPresentation?.count ?? 0} ${deletionPresentation?.count === 1 ? "Chat" : "Chats"}`}
      pendingLabel={deleteProgress.total
        ? `Deleting ${Math.min(deleteProgress.completed + 1, deleteProgress.total)} of ${deleteProgress.total}…`
        : "Deleting…"}
      pending={remove.isPending}
      error={deleteError}
      confirmDisabled={
        !deleteOpen || !previewQuery.data ||
        previewQuery.isFetching ||
        previewQuery.isError ||
        !deleteTargets.length
      }
      onCancel={closeDelete}
      onExited={() => setDeleteDialog(current => current.open ? current : { open: false })}
      onConfirm={() => {
        if (deleteOpen && previewQuery.data) remove.mutate(previewQuery.data);
      }}
    >
      <Alert severity="warning">
        <Stack spacing={0.5}>
          <Typography>Selected Chats, history and assigned Agents: permanently deleted</Typography>
          <Typography>Runs, work logs, private attachments and in-app artifact views: unavailable</Typography>
          <Typography>Pending work: cancelled</Typography>
          <Typography>Working-folder files and Project-level artifacts: retained</Typography>
          <Typography>Chats with active Agents: retained with stop or reassignment instructions</Typography>
        </Stack>
      </Alert>
      {deletionPresentation?.loading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1.5 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">Checking affected Agents…</Typography>
        </Stack>
      ) : null}
      {deletionPresentation?.previews ? <>
        <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
          Selected Chats ({deletionPresentation.previews.length})
        </Typography>
        <Box component="ul" sx={{ maxHeight: 140, overflowY: "auto", mt: 0, mb: 0, pl: 2.5 }}>
          {deletionPresentation.previews.map(preview => (
            <Typography component="li" variant="body2" key={preview.row.conversation.id}>
              {preview.row.conversation.title} · {preview.row.project.label}
            </Typography>
          ))}
        </Box>
        <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
          Agents That Will Be Deleted ({previewAgents.length})
        </Typography>
        {previewAgents.length ? (
          <Box component="ul" sx={{ maxHeight: 180, overflowY: "auto", mt: 0, mb: 0, pl: 2.5 }}>
            {previewAgents.map(({ agent, chatTitle }) => (
              <Typography component="li" variant="body2" key={agent.id}>
                {agent.title}{agent.handle ? ` · @${agent.handle}` : ""}
                <Typography component="span" variant="body2" color="text.secondary">
                  {` · ${chatTitle}`}
                </Typography>
              </Typography>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No Agents are assigned to these Chats.
          </Typography>
        )}
      </> : null}
    </ResourceDeletionDialog>
  </>;
}
