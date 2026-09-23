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
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
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

type ChatRow = WorkspaceConversationDirectoryItemDto;

interface ChatDeletionPreview {
  row: ChatRow;
  agents: AgentDto[];
}

interface ChatDeletionFailure {
  preview: ChatDeletionPreview;
  message: string;
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
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, ChatRow>>(
    () => new Map(),
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
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
  const rows = useMemo(() => {
    const pages = directoryQuery.data?.pages;
    if (!pages?.length) return [];
    const seen = new Set<string>();
    return [
      ...pages[0]!.starredItems,
      ...pages.flatMap(page => page.items),
    ].filter(row => {
      if (seen.has(row.conversation.id)) return false;
      seen.add(row.conversation.id);
      return true;
    });
  }, [directoryQuery.data?.pages]);
  const total = directoryQuery.data?.pages.at(-1)?.total ?? 0;

  // This is the one place where "Select all" must mean the complete matching
  // collection, not only the first paginated slice. Keep ordinary sidebars
  // bounded; only the explicit management workspace follows every page.
  useEffect(() => {
    if (
      directoryQuery.requestState.hasNextPage &&
      !directoryQuery.requestState.isFetchingNextPage &&
      !directoryQuery.requestState.isPaginationError
    ) {
      void directoryQuery.fetchNextPage();
    }
  }, [
    directoryQuery.fetchNextPage,
    directoryQuery.requestState.hasNextPage,
    directoryQuery.requestState.isFetchingNextPage,
    directoryQuery.requestState.isPaginationError,
  ]);

  const visibleSelectedCount = rows.reduce(
    (count, row) => count + Number(selected.has(row.conversation.id)),
    0,
  );
  const allVisibleSelected = rows.length > 0 && visibleSelectedCount === rows.length;
  const collectionComplete =
    directoryQuery.requestState.hasResolved &&
    !directoryQuery.requestState.hasNextPage &&
    !directoryQuery.requestState.isFetchingNextPage &&
    !directoryQuery.requestState.isPaginationError;

  const toggleSelected = (row: ChatRow) => {
    setSelected(current => {
      const next = new Map(current);
      if (next.has(row.conversation.id)) next.delete(row.conversation.id);
      else next.set(row.conversation.id, row);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelected(current => {
      const next = new Map(current);
      if (allVisibleSelected) {
        rows.forEach(row => next.delete(row.conversation.id));
      } else {
        rows.forEach(row => next.set(row.conversation.id, row));
      }
      return next;
    });
  };

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

  const remove = useMutation({
    mutationFn: async (
      previews: ChatDeletionPreview[],
    ): Promise<{
      deleted: ChatDeletionPreview[];
      failures: ChatDeletionFailure[];
    }> => {
      const deleted: ChatDeletionPreview[] = [];
      const failures: ChatDeletionFailure[] = [];
      setDeleteProgress({ completed: 0, total: previews.length });
      for (const preview of previews) {
        try {
          await api.deleteConversation(
            preview.row.conversation.id,
            preview.agents.map(agent => agent.id),
          );
          deleted.push(preview);
        } catch (error) {
          failures.push({ preview, message: errorMessage(error) });
        }
        setDeleteProgress(current => ({
          ...current,
          completed: current.completed + 1,
        }));
      }
      return { deleted, failures };
    },
    onSuccess: ({ deleted, failures }) => {
      const projectIds = new Set(deleted.map(item => item.row.project.id));
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDirectory.kind("conversation"),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all });
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
      setDeleteOpen(false);
      setDeleteTargets([]);
    },
  });

  const openDelete = () => {
    const targets = [...selected.values()];
    if (!targets.length) return;
    setDeleteFailures([]);
    setDeleteProgress({ completed: 0, total: targets.length });
    setDeleteTargets(targets);
    setDeleteOpen(true);
  };
  const closeDelete = () => {
    if (remove.isPending) return;
    setDeleteOpen(false);
    setDeleteTargets([]);
    setDeleteFailures([]);
    remove.reset();
  };

  const previewAgents = previewQuery.data?.flatMap(preview =>
    preview.agents.map(agent => ({
      agent,
      chatTitle: preview.row.conversation.title,
    })),
  ) ?? [];
  const deleteError = previewQuery.isError
    ? "Ponderosa could not verify every affected Agent. Try again before deleting."
    : deleteFailures.length
      ? <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
          {deleteFailures.map(failure => (
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
          {selected.size ? `Delete selected (${selected.size})` : "Delete selected"}
        </Button>
      }
      compactPrimaryAction={
        <Tooltip title={selected.size ? `Delete ${selected.size} selected Chats` : "Select Chats to delete"}>
          <span>
            <IconButton
              color="error"
              aria-label={selected.size ? `Delete ${selected.size} selected Chats` : "Delete selected Chats"}
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
          searchLabel="Search Chats to manage"
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
              Select all
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
      listLabel="Chats available for bulk management"
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
      title={`Delete ${deleteTargets.length} selected ${deleteTargets.length === 1 ? "Chat" : "Chats"}?`}
      confirmLabel={`Delete ${deleteTargets.length} ${deleteTargets.length === 1 ? "Chat" : "Chats"}`}
      pendingLabel={deleteProgress.total
        ? `Deleting ${Math.min(deleteProgress.completed + 1, deleteProgress.total)} of ${deleteProgress.total}…`
        : "Deleting…"}
      pending={remove.isPending}
      error={deleteError}
      confirmDisabled={
        !previewQuery.data ||
        previewQuery.isFetching ||
        previewQuery.isError ||
        !deleteTargets.length
      }
      onCancel={closeDelete}
      onConfirm={() => {
        if (previewQuery.data) remove.mutate(previewQuery.data);
      }}
    >
      <Alert severity="warning">
        This permanently deletes the selected Chats and their history, plus all
        assigned Agents. Their runs, work logs, private attachments, and in-app
        artifact views will no longer be available. Pending work is cancelled.
        Files actually saved in a machine working folder and Project-level
        artifacts are not deleted. A Chat with an enabled Automation or an
        active Agent will remain and report what must be stopped or reassigned.
      </Alert>
      {previewQuery.isFetching ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1.5 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">Checking affected Agents…</Typography>
        </Stack>
      ) : null}
      {previewQuery.data ? <>
        <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
          Selected Chats ({previewQuery.data.length})
        </Typography>
        <Box component="ul" sx={{ maxHeight: 140, overflowY: "auto", mt: 0, mb: 0, pl: 2.5 }}>
          {previewQuery.data.map(preview => (
            <Typography component="li" variant="body2" key={preview.row.conversation.id}>
              {preview.row.conversation.title} · {preview.row.project.label}
            </Typography>
          ))}
        </Box>
        <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
          Agents that will be deleted ({previewAgents.length})
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
