import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from "@mui/material";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { scopedAttention } from "../attention";
import { api } from "../api";

function outcomeLabel(outcome: NonNullable<WorkspaceNotificationDto["resolution"]>["outcome"]): string {
  return outcome.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
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
  const items = scopedAttention(notifications, {
    ...(projectId ? { projectId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(conversationAgentIds ? { conversationAgentIds } : {}),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
      queryClient.invalidateQueries({ queryKey: ["decisions"] }),
      queryClient.invalidateQueries({ queryKey: ["agent-work"] }),
    ]);
  };
  const respond = useMutation({
    mutationFn: ({ id, optionId, text }: { id: string; optionId?: string; text?: string }) =>
      api.respondDecision(id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) }),
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: (notificationId: string) => api.setNotificationStatus(notificationId, "resolved"),
    onSuccess: refresh,
  });
  if (!items.length) return null;
  const first = items[0]!;
  const urgent = items.some((item) => item.severity === "urgent");
  const pending = respond.isPending || resolve.isPending;

  return <>
    <Alert
      severity={urgent ? "error" : "warning"}
      icon={<ReportProblemOutlinedIcon />}
      action={<Button color="inherit" size="small" onClick={() => setOpen(true)}>{items.length === 1 ? "Resolve" : "View Issues"}</Button>}
      sx={{ mx: { xs: 1.5, md: 2.5 }, mt: 1.5, alignItems: "center", "& .MuiAlert-message": { width: "100%", minWidth: 0 } }}
    >
      <Typography variant="body2" fontWeight={850}>{items.length === 1 ? first.title : `${items.length} current issues`}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        {items.length === 1 ? first.body : `${first.title} and ${items.length - 1} more.`}
      </Typography>
    </Alert>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm" aria-labelledby="current-issues-title">
      <DialogTitle id="current-issues-title">Current Issues</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {items.map((item, index) => <Box key={item.id}>
            {index ? <Divider sx={{ mb: 2 }} /> : null}
            <Stack spacing={1}>
              <Box>
                <Typography fontWeight={850}>{item.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, overflowWrap: "anywhere" }}>{item.body}</Typography>
              </Box>
              {item.resolution?.kind === "coordination_request" ? <>
                <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                  <Chip size="small" label={item.resolution.recipientTitle} />
                  <Chip size="small" color="warning" variant="outlined" label={outcomeLabel(item.resolution.outcome)} />
                </Stack>
                <Box sx={{ bgcolor: "action.hover", borderRadius: 1.5, p: 1.25 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>ASSIGNMENT</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.resolution.assignment}</Typography>
                </Box>
                {item.resolution.retryAvailable ? <Alert severity="info">
                  Recovery must be chosen through a contextual Decision so the affected Agent, assignment, and consequences are explicit. Technical Details remains read-only evidence.
                </Alert> : null}
              </> : null}
              {item.kind === "decision" && item.decision ? <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {item.decision.options.map((option) => <Button key={option.id} size="small" variant="outlined" disabled={pending} onClick={() => respond.mutate({ id: item.decision!.id, optionId: option.id })}>{option.label}</Button>)}
                {(item.decision.allowOther || item.decision.mode === "text") ? <Button size="small" variant="outlined" disabled={pending} onClick={() => {
                  const answer = window.prompt(item.decision!.mode === "text" ? "Your answer" : "What should the Agent do instead?");
                  if (answer?.trim()) respond.mutate({ id: item.decision!.id, text: answer.trim() });
                }}>{item.decision.mode === "text" ? "Answer" : "Something Else"}</Button> : null}
              </Stack> : null}
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {item.kind !== "decision" ? <Button size="small" variant="outlined" disabled={pending} onClick={() => resolve.mutate(item.id)}>No Further Action</Button> : null}
                {onOpen ? <Button size="small" color="inherit" onClick={() => { setOpen(false); onOpen(item); }}>Open Technical Details</Button> : null}
              </Stack>
            </Stack>
          </Box>)}
          {respond.isError || resolve.isError ? <Alert severity="error">The issue could not be updated. Review the current state and try again.</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
