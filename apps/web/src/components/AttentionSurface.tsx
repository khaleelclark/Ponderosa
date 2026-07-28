import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import { Alert, Box, Button, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from "@mui/material";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { scopedAttention } from "../attention";
import { api } from "../api";
import { copyText } from "../clipboard";
import { notificationDecision } from "../decisions";
import { queryKeys } from "../queryKeys";
import { DecisionCard } from "./decisions/DecisionCard";

function outcomeLabel(outcome: NonNullable<WorkspaceNotificationDto["resolution"]>["outcome"]): string {
  return outcome.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function issueCopy(item: WorkspaceNotificationDto): {
  title: string;
  explanation: string;
  impact: string;
  recommendation: string;
} {
  const resolution = item.resolution;
  if (resolution?.kind !== "coordination_request") {
    return {
      title: item.title,
      explanation: item.body,
      impact: "Ponderosa will preserve the affected work while this item remains open.",
      recommendation: "Review the affected work and choose whether this item still needs attention.",
    };
  }
  const name = resolution.recipientTitle;
  const byOutcome: Record<string, Pick<ReturnType<typeof issueCopy>, "title" | "explanation">> = {
    failed: {
      title: `${name} could not finish this assignment`,
      explanation: `${name} reported that the assignment failed before delivering a usable result.`,
    },
    blocked: {
      title: `${name} is blocked`,
      explanation: `${name} cannot continue this assignment without a change in its current conditions.`,
    },
    expired: {
      title: `${name}'s assignment expired`,
      explanation: `The assignment reached its deadline before ${name} delivered a result.`,
    },
    outcome_unknown: {
      title: `Ponderosa could not confirm whether ${name} finished`,
      explanation: `The run ended without a confirmed final result, so Ponderosa will not assume the assignment succeeded.`,
    },
    recipient_unavailable: {
      title: `${name} is no longer available`,
      explanation: `The assigned Agent cannot receive or finish this work in its current state.`,
    },
  };
  const copy = byOutcome[resolution.outcome] ?? {
    title: item.title,
    explanation: item.body,
  };
  return {
    ...copy,
    impact: "Other completed Project work is unchanged. This assignment will not continue automatically.",
    recommendation: resolution.retryAvailable
      ? `Retry the assignment. ${name} will first inspect the current state so completed side effects are not blindly repeated.`
      : "Continue without this assignment or inspect the affected work for more context.",
  };
}

function supportReport(item: WorkspaceNotificationDto): string {
  const copy = issueCopy(item);
  const resolution = item.resolution;
  return [
    "Ponderosa Support Report",
    `Issue: ${copy.title}`,
    `Explanation: ${copy.explanation}`,
    `Impact: ${copy.impact}`,
    `Recommended action: ${copy.recommendation}`,
    `Created: ${new Date(item.createdAt).toLocaleString()}`,
    `Notification ID: ${item.id}`,
    item.projectId ? `Project ID: ${item.projectId}` : undefined,
    item.conversationId ? `Chat ID: ${item.conversationId}` : undefined,
    item.agentId ? `Agent ID: ${item.agentId}` : undefined,
    resolution?.kind === "coordination_request" ? `Assignment: ${resolution.assignment}` : undefined,
    resolution?.kind === "coordination_request" ? `Outcome: ${resolution.outcome}` : undefined,
    resolution?.kind === "coordination_request" ? `Request ID: ${resolution.requestId}` : undefined,
    resolution?.kind === "coordination_request" ? `Trace ID: ${resolution.traceId}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function AttentionSurface({
  notifications,
  projectId,
  conversationId,
  agentId,
  conversationAgentIds,
  onOpen,
}: {
  notifications: WorkspaceNotificationDto[];
  projectId?: string;
  conversationId?: string;
  agentId?: string;
  conversationAgentIds?: string[];
  onOpen?(item: WorkspaceNotificationDto): void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [expandedIssueId, setExpandedIssueId] = useState<string>();
  const [copiedIssueId, setCopiedIssueId] = useState<string>();
  const items = scopedAttention(notifications, {
    ...(projectId ? { projectId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(conversationAgentIds ? { conversationAgentIds } : {}),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.decisions.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentWork.all }),
    ]);
  };
  const resolve = useMutation({
    mutationFn: (notificationId: string) => api.setNotificationStatus(notificationId, "resolved"),
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
  const firstCopy = issueCopy(first);
  const urgent = items.some((item) => item.severity === "urgent");
  const pending = resolve.isPending || retry.isPending;

  return <>
    <Alert
      severity={urgent ? "error" : "warning"}
      icon={<ReportProblemOutlinedIcon />}
      action={<Button color="inherit" size="small" onClick={() => setOpen(true)}>{items.length === 1 ? "Review" : "Review All"}</Button>}
      sx={{ mx: { xs: 1.5, md: 2.5 }, mt: 1.5, alignItems: "center", "& .MuiAlert-message": { width: "100%", minWidth: 0 } }}
    >
      <Typography variant="body2" fontWeight={850}>{items.length === 1 ? firstCopy.title : `${items.length} items need your attention`}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        {items.length === 1 ? firstCopy.explanation : `${firstCopy.title} and ${items.length - 1} more.`}
      </Typography>
    </Alert>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm" aria-labelledby="current-issues-title">
      <DialogTitle id="current-issues-title">
        <Typography variant="h6">Needs Your Attention</Typography>
        <Typography variant="body2" color="text.secondary">Ponderosa needs a decision before it can consider this work settled.</Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {items.map((item, index) => {
            const copy = issueCopy(item);
            const coordination = item.resolution?.kind === "coordination_request" ? item.resolution : undefined;
            const expanded = expandedIssueId === item.id;
            return <Box key={item.id}>
            {index ? <Divider sx={{ mb: 2 }} /> : null}
            <Stack spacing={1.25}>
              {item.kind === "decision" && item.decision
                ? <DecisionCard decision={notificationDecision(item)!} title={item.title} context={item.body} />
                : <Box>
                    <Typography fontWeight={850}>{copy.title}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, overflowWrap: "anywhere" }}>{copy.explanation}</Typography>
                  </Box>}
              <Alert severity="info" icon={false} sx={{ py: 0.75 }}>
                <Typography variant="caption" fontWeight={850}>WHAT THIS AFFECTS</Typography>
                <Typography variant="body2">{copy.impact}</Typography>
              </Alert>
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={850}>RECOMMENDED</Typography>
                <Typography variant="body2">{copy.recommendation}</Typography>
              </Box>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {coordination?.retryAvailable ? <Button size="small" variant="contained" disabled={pending} onClick={() => retry.mutate(item)}>Retry Assignment</Button> : null}
                {item.kind !== "decision" ? <Button size="small" variant={coordination?.retryAvailable ? "text" : "outlined"} color="inherit" disabled={pending} onClick={() => resolve.mutate(item.id)}>
                  {coordination ? "Continue Without It" : "Dismiss"}
                </Button> : null}
                <Button
                  size="small"
                  color="inherit"
                  endIcon={<ExpandMoreIcon sx={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms" }} />}
                  onClick={() => setExpandedIssueId(expanded ? undefined : item.id)}
                >
                  What Happened?
                </Button>
              </Stack>
              <Collapse in={expanded} unmountOnExit>
                <Box sx={{ bgcolor: "action.hover", borderRadius: 1.5, p: 1.25 }}>
                  {coordination ? <>
                    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
                      <Chip size="small" label={coordination.recipientTitle} />
                      <Chip size="small" color="warning" variant="outlined" label={outcomeLabel(coordination.outcome)} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary" fontWeight={800}>ASSIGNMENT</Typography>
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{coordination.assignment}</Typography>
                  </> : <Typography variant="body2" color="text.secondary">{item.body}</Typography>}
                  <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                    {onOpen ? <Button size="small" color="inherit" onClick={() => { setOpen(false); onOpen(item); }}>View Diagnostics</Button> : null}
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<ContentCopyIcon />}
                      onClick={() => {
                        void copyText(supportReport(item)).then(() => {
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
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
