import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { WorkspaceTriggerDirectoryItemDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useManagedWorkspaceCollection } from "../hooks/useManagedWorkspaceCollection";
import { useWorkspaceDirectory } from "../hooks/useWorkspaceDirectory";
import { queryKeys } from "../queryKeys";
import type { Route } from "../routing";
import {
  CollectionStateFeedback,
  CollectionToolbar,
  CollectionWorkspace,
} from "./CollectionPrimitives";
import { ResourceDeletionDialog } from "./ConfirmationDialogs";

type AutomationRow = WorkspaceTriggerDirectoryItemDto;
const automationRowId = (row: AutomationRow) => row.trigger.id;

interface AutomationDeletionFailure {
  row: AutomationRow;
  message: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ManageAutomationsWorkspace({
  onNavigate,
}: {
  onNavigate(route: Route): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<AutomationRow[]>([]);
  const [deleteFailures, setDeleteFailures] = useState<AutomationDeletionFailure[]>([]);
  const [deleteProgress, setDeleteProgress] = useState({ completed: 0, total: 0 });

  const directoryQuery = useWorkspaceDirectory<WorkspaceTriggerDirectoryItemDto>(
    "trigger",
    { search },
  );
  const {
    rows, total, selected, setSelected, visibleSelectedCount,
    allVisibleSelected, collectionComplete, toggleSelected, toggleSelectAll,
  } = useManagedWorkspaceCollection(directoryQuery, automationRowId);

  const remove = useMutation({
    mutationFn: async (
      targets: AutomationRow[],
    ): Promise<{
      deleted: AutomationRow[];
      failures: AutomationDeletionFailure[];
    }> => {
      const deleted: AutomationRow[] = [];
      const failures: AutomationDeletionFailure[] = [];
      setDeleteProgress({ completed: 0, total: targets.length });
      for (const row of targets) {
        try {
          await api.deleteTrigger(row.trigger.id);
          deleted.push(row);
        } catch (error) {
          failures.push({ row, message: errorMessage(error) });
        }
        setDeleteProgress(current => ({
          ...current,
          completed: current.completed + 1,
        }));
      }
      return { deleted, failures };
    },
    onSuccess: ({ deleted, failures }) => {
      const projectIds = new Set(deleted.map(row => row.project.id));
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDirectory.kind("trigger"),
      });
      projectIds.forEach(projectId => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.triggers.project(projectId),
        });
      });
      setSelected(current => {
        const next = new Map(current);
        deleted.forEach(row => next.delete(row.trigger.id));
        return next;
      });
      setDeleteFailures(failures);
      if (failures.length) {
        setDeleteTargets(failures.map(failure => failure.row));
        return;
      }
      setDeleteOpen(false);
      setDeleteTargets([]);
    },
  });

  const openDelete = () => {
    const targets = [...selected.values()];
    if (!targets.length) return;
    setDeleteTargets(targets);
    setDeleteFailures([]);
    setDeleteProgress({ completed: 0, total: targets.length });
    setDeleteOpen(true);
  };
  const closeDelete = () => {
    if (remove.isPending) return;
    setDeleteOpen(false);
    setDeleteTargets([]);
    setDeleteFailures([]);
    remove.reset();
  };
  const enabledCount = deleteTargets.filter(row => row.trigger.enabled).length;

  return <>
    <CollectionWorkspace
      icon={<BoltOutlinedIcon />}
      title="Manage Automations"
      detail={directoryQuery.requestState.hasResolved
        ? `${total} ${total === 1 ? "Automation" : "Automations"} across Ponderosa`
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
        <Tooltip title={selected.size ? `Delete ${selected.size} selected Automations` : "Select Automations to delete"}>
          <span>
            <IconButton
              color="error"
              aria-label={selected.size ? `Delete ${selected.size} selected Automations` : "Delete selected Automations"}
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
          searchLabel="Search Automations to manage"
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
                ? "Loading all Automations…"
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
      listLabel="Automations available for bulk management"
      busy={
        directoryQuery.requestState.isInitialLoading ||
        directoryQuery.requestState.isRefreshing ||
        directoryQuery.requestState.isFetchingNextPage
      }
    >
      {rows.map(row => {
        const checked = selected.has(row.trigger.id);
        return <Paper
          key={row.trigger.id}
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
            inputProps={{ "aria-label": `Select ${row.trigger.name}` }}
          />
          <Box sx={{ minWidth: 0, flex: 1, py: 0.5 }}>
            <Typography noWrap fontWeight={700}>{row.trigger.name}</Typography>
            <Typography noWrap variant="caption" color="text.secondary">
              {row.project.label} · {row.targetAgent?.title ?? "No target Agent"}
            </Typography>
          </Box>
          <Chip
            size="small"
            label={row.trigger.enabled ? "Enabled" : "Disabled"}
            color={row.trigger.enabled ? "success" : "default"}
            variant={row.trigger.enabled ? "filled" : "outlined"}
            sx={{ mr: 0.5 }}
          />
          <Tooltip title={`Open ${row.trigger.name}`}>
            <IconButton
              aria-label={`Open ${row.trigger.name}`}
              onClick={() => onNavigate({
                kind: "automation",
                projectId: row.project.id,
                triggerId: row.trigger.id,
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
        resourceLabel="Automations"
        emptyTitle="No Automations Yet"
        emptyDetail="There are no Automations to manage."
        noMatchTitle="No Automations match this search"
        noMatchDetail="Try a different search."
        onClearFilters={() => setSearch("")}
      />
    </CollectionWorkspace>

    <ResourceDeletionDialog
      open={deleteOpen}
      resourceType="Automations"
      title={`Delete ${deleteTargets.length} selected ${deleteTargets.length === 1 ? "Automation" : "Automations"}?`}
      confirmLabel={`Delete ${deleteTargets.length} ${deleteTargets.length === 1 ? "Automation" : "Automations"}`}
      pendingLabel={deleteProgress.total
        ? `Deleting ${Math.min(deleteProgress.completed + 1, deleteProgress.total)} of ${deleteProgress.total}…`
        : "Deleting…"}
      pending={remove.isPending}
      error={deleteFailures.length
        ? <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
            {deleteFailures.map(failure => (
              <Typography component="li" variant="body2" key={failure.row.trigger.id}>
                {failure.row.trigger.name}: {failure.message}
              </Typography>
            ))}
          </Stack>
        : undefined}
      confirmDisabled={!deleteTargets.length}
      onCancel={closeDelete}
      onConfirm={() => remove.mutate(deleteTargets)}
    >
      <Alert severity="warning">
        This permanently deletes the selected Automations. Pending and future
        occurrences are cancelled; immutable occurrence history remains
        available. The target Agents, Chats, Project artifacts, and files saved
        on the machine are not deleted.
      </Alert>
      {enabledCount ? (
        <Typography variant="body2" sx={{ mt: 1.5 }}>
          {enabledCount} enabled {enabledCount === 1 ? "Automation will" : "Automations will"} stop running.
        </Typography>
      ) : null}
      <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
        Automations that will be deleted ({deleteTargets.length})
      </Typography>
      <Box component="ul" sx={{ maxHeight: 240, overflowY: "auto", mt: 0, mb: 0, pl: 2.5 }}>
        {deleteTargets.map(row => (
          <Typography component="li" variant="body2" key={row.trigger.id}>
            {row.trigger.name} · {row.project.label}
          </Typography>
        ))}
      </Box>
    </ResourceDeletionDialog>
  </>;
}
