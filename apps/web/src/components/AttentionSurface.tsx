import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { scopedAttention } from "../attention";
import { api } from "../api";

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
  const items = scopedAttention(notifications, { ...(projectId ? { projectId } : {}), ...(conversationId ? { conversationId } : {}), ...(agentId ? { agentId } : {}) });
  const respond = useMutation({
    mutationFn: ({ id, optionId, text }: { id: string; optionId?: string; text?: string }) =>
      api.respondDecision(id, { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["notifications"] }),
        queryClient.invalidateQueries({ queryKey: ["decisions"] }),
      ]);
    },
  });
  if (!items.length) return null;
  const urgent = items.some((item) => item.severity === "urgent");
  return <Alert
    severity={urgent ? "error" : "warning"}
    icon={<WarningAmberOutlinedIcon />}
    sx={{ mx: { xs: 1.5, md: 2.5 }, mt: 1.5, alignItems: "flex-start", "& .MuiAlert-message": { width: "100%", minWidth: 0 } }}
  >
    <Stack spacing={1}>
      <Box>
        <Typography fontWeight={850}>{items.length === 1 ? "1 item needs your attention" : `${items.length} items need your attention`}</Typography>
        <Typography variant="body2">These remain visible until they are answered, resolved, or dismissed.</Typography>
      </Box>
      {items.slice(0, 3).map((item) => <Box key={item.id} sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" } }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" fontWeight={800}>{item.title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>{item.body}</Typography>
          </Box>
          {item.kind !== "decision" && onOpen ? <Button size="small" variant="outlined" onClick={() => onOpen(item)}>Review</Button> : null}
        </Stack>
        {item.kind === "decision" && item.decision ? <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 0.75 }}>
          {item.decision.options.map((option) => <Button key={option.id} size="small" variant="outlined" disabled={respond.isPending} onClick={() => respond.mutate({ id: item.decision!.id, optionId: option.id })}>{option.label}</Button>)}
          {(item.decision.allowOther || item.decision.mode === "text") ? <Button size="small" variant="outlined" disabled={respond.isPending} onClick={() => {
            const answer = window.prompt(item.decision!.mode === "text" ? "Your answer" : "What should the Agent do instead?");
            if (answer?.trim()) respond.mutate({ id: item.decision!.id, text: answer.trim() });
          }}>{item.decision.mode === "text" ? "Answer" : "Something Else"}</Button> : null}
        </Stack> : null}
      </Box>)}
      {items.length > 3 ? <Typography variant="caption" color="text.secondary">+{items.length - 3} more in Notifications</Typography> : null}
      {respond.isError ? <Typography variant="body2" color="error">The decision response could not be sent. Try again from Notifications.</Typography> : null}
    </Stack>
  </Alert>;
}
