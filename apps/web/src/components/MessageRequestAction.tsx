import CloseIcon from "@mui/icons-material/Close";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { Dialog, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { CollaborationRecipientDto, CoordinationRequestSummaryDto, MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useId, useState } from "react";
import { RequestLifecycleCard } from "./RequestLifecycleCard";

/** Availability comes from canonical request summaries, never message prose. */
export function MessageRequestAction({ projectId, conversationId, requests, recipients, receipts, agentTitle }: {
  projectId?: string;
  conversationId?: string;
  requests?: CoordinationRequestSummaryDto[];
  recipients?: CollaborationRecipientDto[];
  receipts?: MessageDeliveryReceiptDto[];
  agentTitle: (agentId: string | undefined) => string;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const linkedRequests = [...new Map((requests ?? [])
    .filter(request => request.recordId.trim())
    .map(request => [request.recordId, request])).values()];
  if (!projectId || (!linkedRequests.length && !recipients?.length)) return null;
  const label = recipients?.length ? "View message details" : linkedRequests.length === 1 ? "View request" : "View requests";
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
      aria-labelledby={titleId}
      aria-label={recipients?.length ? "Message details" : linkedRequests.length === 1 ? "Request details" : "Request details for this message"}
      onClick={event => event.stopPropagation()}
    >
      <DialogTitle id={`${titleId}-container`} sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span id={titleId}>{recipients?.length ? "Message details" : "Request details"}</span>
        <IconButton aria-label={recipients?.length ? "Close message details" : "Close request details"} onClick={() => setOpen(false)}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          {recipients?.length ? <>
            <Typography variant="body2"><strong>Addressed to:</strong> {recipients.map(recipient => recipient.handle ? `#${recipient.handle}` : "Unavailable recipient").join(", ")}</Typography>
            <Typography variant="body2"><strong>Human visibility:</strong> Team and participant timelines; access is unchanged.</Typography>
            <Typography variant="body2"><strong>Delivery evidence:</strong> {linkedRequests.length
              ? "Linked Request and Join records."
              : receipts?.length ? "Recorded delivery statuses."
                : "No linked delivery evidence."}</Typography>
            {receipts?.map(receipt => <Typography key={receipt.activationId} variant="body2">
              {recipients.find(recipient => recipient.id === receipt.targetAgentId)?.handle
                ? `#${recipients.find(recipient => recipient.id === receipt.targetAgentId)!.handle}` : "Recipient"}: {receipt.state.replaceAll("_", " ")}
              {receipt.providerAcknowledged ? "; provider acknowledged input (not reading or understanding)" : ""}
            </Typography>)}
          </> : null}
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
