import CloseIcon from "@mui/icons-material/Close";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { Dialog, DialogContent, DialogTitle, IconButton, Stack, Tooltip } from "@mui/material";
import type { CoordinationRequestSummaryDto } from "@ponderosa/core";
import { useState } from "react";
import { RequestLifecycleCard } from "./RequestLifecycleCard";

/** Availability comes from canonical request summaries, never message prose. */
export function MessageRequestAction({ projectId, conversationId, requests, agentTitle }: {
  projectId?: string;
  conversationId?: string;
  requests?: CoordinationRequestSummaryDto[];
  agentTitle: (agentId: string | undefined) => string;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const linkedRequests = [...new Map((requests ?? [])
    .filter(request => request.recordId.trim())
    .map(request => [request.recordId, request])).values()];
  if (!projectId || !linkedRequests.length) return null;
  const label = linkedRequests.length === 1 ? "View request" : "View requests";
  return <>
    <Tooltip title={label}>
      <IconButton size="small" aria-label={label} onClick={(event) => {
        event.stopPropagation();
        setOpen(true);
      }}>
        <DescriptionOutlinedIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
    {open ? <Dialog open onClose={() => setOpen(false)} fullWidth maxWidth="md"
      aria-label={linkedRequests.length === 1 ? "Request details" : "Request details for this message"}
      onClick={event => event.stopPropagation()}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        Request details
        <IconButton aria-label="Close request details" onClick={() => setOpen(false)}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          {linkedRequests.map(request => <RequestLifecycleCard
            key={request.recordId}
            projectId={projectId}
            conversationId={request.conversationId ?? conversationId}
            requestId={request.recordId}
            state={request.state}
            requesterAgentId={request.requesterAgentId}
            recipientAgentId={request.recipientAgentId}
            requestText={request.preview}
            hasUpdates={request.hasUpdates}
            hasResult={request.hasResult}
            updatedAt={request.updatedAt}
            agentTitle={agentTitle}
            defaultExpanded
          />)}
        </Stack>
      </DialogContent>
    </Dialog> : null}
  </>;
}
