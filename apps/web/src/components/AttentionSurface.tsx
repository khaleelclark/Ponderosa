import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import { Alert, Box, Button, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { attentionPresentation, attentionSupportReport, scopedAttention } from "../attention";
import { api } from "../api";
import { copyText } from "../clipboard";
import { notificationDecision } from "../decisions";
import { queryKeys } from "../queryKeys";
import { DecisionCard } from "./decisions/DecisionCard";

export function AttentionSurface({
  notifications,
  projectId,
  conversationId,
  agentId,
  onOpen,
}: {
  notifications: WorkspaceNotificationDto[];
  projectId?: string;
  conversationId?: string;
  agentId?: string;
  onOpen?(item: WorkspaceNotificationDto): void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const mobileReview = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [open, setOpen] = useState(false);
  const [expandedIssueId, setExpandedIssueId] = useState<string>();
  const [copiedIssueId, setCopiedIssueId] = useState<string>();
  const [retryItem, setRetryItem] = useState<WorkspaceNotificationDto>();
  const items = scopedAttention(notifications, {
    ...(projectId ? { projectId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId } : {}),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.decisions.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentWork.all }),
    ]);
  };
  const resolve = useMutation({
    mutationFn: (notificationId: string) => api.setNotificationStatus(notificationId, "dismissed"),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: (item: WorkspaceNotificationDto) => {
      if (item.resolution?.kind !== "coordination_request") throw new Error("This assignment cannot be retried.");
      return api.retryCoordinationRequest(item.resolution.requestId, {
        idempotencyKey: `operator-retry:${item.id}`,
      });
    },
    onSuccess: refresh,
  });
  if (!items.length) return null;
  const first = items[0]!;
  const pendingQuestions = items.filter((item) => item.kind === "decision" && item.decision?.status === "pending");
  const firstCopy = attentionPresentation(first);
  const unacknowledgedItems = items.filter((item) => !item.acknowledgedAt);
  const urgent = unacknowledgedItems.some((item) => item.severity === "urgent");
  const pending = resolve.isPending || retry.isPending;

  return <Box component="section" aria-label="Needs your attention" sx={{ minWidth: 0, maxHeight: "min(40dvh, 360px)", overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", pb: 1.5 }}>
    {pendingQuestions.map((item) => {
      const decision = notificationDecision(item);
      return decision ? <Box key={item.id} sx={{ mx: { xs: 1.5, md: 2.5 }, mt: 1.5 }}>
        <DecisionCard
          decision={decision}
          title={item.body}
          context=""
        />
      </Box> : null;
    })}
    <Alert
      severity={urgent ? "error" : unacknowledgedItems.length ? "warning" : "info"}
      icon={<ReportProblemOutlinedIcon />}
      action={<Button color="inherit" size="small" onClick={() => setOpen(true)}>{unacknowledgedItems.length ? (items.length === 1 ? "Review" : "Review All") : "View"}</Button>}
      sx={{ mx: { xs: 1.5, md: 2.5 }, mt: 1.5, alignItems: "center", "& .MuiAlert-message": { width: "100%", minWidth: 0 } }}
    >
      <Typography variant="body2" fontWeight={850}>{unacknowledgedItems.length
        ? (items.length === 1 ? firstCopy.title : `${items.length} items need your attention`)
        : `${items.length} open action${items.length === 1 ? "" : "s"}`}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        {unacknowledgedItems.length
          ? (items.length === 1 ? firstCopy.explanation : `${firstCopy.title} and ${items.length - 1} more.`)
          : "Reviewed. This stays visible until the underlying work is resolved or you dismiss it."}
      </Typography>
    </Alert>
    <Dialog open={open} onClose={() => setOpen(false)} fullScreen={mobileReview} fullWidth maxWidth="sm" aria-labelledby="current-issues-title">
      <DialogTitle id="current-issues-title">
        <Typography variant="h6">Needs Your Attention</Typography>
        <Typography variant="body2" color="text.secondary">Check the affected work before deciding what to do next.</Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 1.5, sm: 3 }, minHeight: 0, overflowX: "hidden" }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
          Dismiss removes only the notice. It does not retry, cancel, or delete work.
        </Typography>
        <Stack spacing={2}>
          {items.map((item) => {
            const copy = attentionPresentation(item);
            const coordination = item.resolution?.kind === "coordination_request" ? item.resolution : undefined;
            const expanded = expandedIssueId === item.id;
            return <Box key={item.id} component="article" data-notification-id={item.id} aria-label={copy.reference} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, minWidth: 0 }}>
            <Stack spacing={1} sx={{ overflowWrap: "anywhere" }}>
              <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{ alignItems: "center" }}>
                <Chip size="small" color={item.acknowledgedAt ? "default" : "warning"} label={item.acknowledgedAt ? "Reviewed · still open" : "Needs review"} />
                <Typography component="time" dateTime={copy.occurredAt} variant="caption" color="text.secondary">{new Date(copy.occurredAt).toLocaleString()}</Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">{copy.scopes.join(" · ")}</Typography>
              <Typography variant="caption" color="text.secondary">{copy.reference}</Typography>
              {item.kind === "decision" && item.decision
                ? <DecisionCard decision={notificationDecision(item)!} title={item.title} context={item.body} />
                : <Box>
                    <Typography fontWeight={850}>{copy.title}</Typography>
                  </Box>}
              {item.kind !== "decision" ? <>
                {copy.task || copy.taskUnavailableLabel ? <Typography variant="body2" fontWeight={650}>{copy.task ?? copy.taskUnavailableLabel}</Typography> : null}
                <Typography variant="body2" color="text.secondary">{copy.explanation}</Typography>
                {copy.evidenceUnavailable ? <Typography variant="caption" color="text.secondary">No additional cause details were retained for this older notice.</Typography> : null}
                {!onOpen || (!item.projectId && item.action?.kind !== "open_settings") ? <Typography variant="caption" color="text.secondary">No activity link is available for this notice.</Typography> : null}
              </> : null}
              {copy.uncertainty ? <Box>
                <Typography variant="body2" color="text.secondary">{copy.uncertainty}</Typography>
              </Box> : null}
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {onOpen && (item.projectId || item.action?.kind === "open_settings") ? <Button size="small" variant="outlined" onClick={() => { setOpen(false); onOpen(item); }}>{item.action?.kind === "open_settings" ? "Open details" : "Open activity"}</Button> : null}
                {coordination?.retryAvailable ? <Button size="small" disabled={pending} onClick={() => { retry.reset(); setRetryItem(item); }}>Retry assignment…</Button> : null}
                {item.kind !== "decision" ? <Button size="small" color="inherit" disabled={pending} onClick={() => resolve.mutate(item.id)}>
                  Dismiss
                </Button> : null}
                <Button
                  size="small"
                  color="inherit"
                  endIcon={<ExpandMoreIcon sx={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms" }} />}
                  aria-expanded={expanded}
                  onClick={() => setExpandedIssueId(expanded ? undefined : item.id)}
                >
                  Details
                </Button>
              </Stack>
              <Collapse in={expanded} unmountOnExit>
                <Box sx={{ bgcolor: "action.hover", borderRadius: 1.5, p: 1.25 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Notice ID: {item.id}</Typography>
                  {item.workContext ? <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Work record: {item.workContext.kind}:{item.workContext.recordId}</Typography>
                    : coordination ? <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Assignment ID: {coordination.requestId}</Typography> : null}
                  <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<ContentCopyIcon />}
                      onClick={() => {
                        void copyText(attentionSupportReport(item)).then(() => {
                          setCopiedIssueId(item.id);
                          globalThis.setTimeout(() => setCopiedIssueId(undefined), 1_500);
                        });
                      }}
                    >
                      {copiedIssueId === item.id ? "Copied" : "Copy Support Report"}
                    </Button>
                  </Stack>
                </Box>
              </Collapse>
            </Stack>
          </Box>;
          })}
          {resolve.isError || retry.isError ? <Alert severity="error">{(resolve.error ?? retry.error) instanceof Error ? (resolve.error ?? retry.error as Error).message : "The issue could not be updated. Review the current state and try again."}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close review</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(retryItem)} onClose={() => { if (!retry.isPending) setRetryItem(undefined); }} fullWidth maxWidth="xs" aria-labelledby="retry-assignment-title">
      <DialogTitle id="retry-assignment-title">Retry this assignment?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">{retryItem ? attentionPresentation(retryItem).task ?? "Assignment description unavailable." : ""}</Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>Earlier work or changes may already exist. Retrying starts another attempt and may duplicate changes. Review the activity first.</Typography>
        {retry.isError ? <Alert severity="error" sx={{ mt: 1 }}>{retry.error instanceof Error ? retry.error.message : "The retry could not be started."}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button disabled={retry.isPending} onClick={() => setRetryItem(undefined)}>Not now</Button>
        <Button disabled={retry.isPending} onClick={() => { if (retryItem) retry.mutate(retryItem, { onSuccess: () => setRetryItem(undefined) }); }}>{retry.isPending ? "Starting…" : "Retry assignment"}</Button>
      </DialogActions>
    </Dialog>
  </Box>;
}
