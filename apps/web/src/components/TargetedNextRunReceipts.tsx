import ScheduleSendOutlinedIcon from "@mui/icons-material/ScheduleSendOutlined";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import type {
  TargetedNextRunDeliveryState,
  TargetedNextRunReceiptDto,
} from "@ponderosa/core";

const stateLabel = (state: TargetedNextRunDeliveryState): string => {
  if (state === "pending") return "Pending · delivers on next run";
  if (state === "delivered") return "Delivered";
  if (state === "expired") return "Expired";
  return "Unavailable";
};

const stateColor = (
  state: TargetedNextRunDeliveryState,
): "default" | "success" | "warning" => {
  if (state === "delivered") return "success";
  if (state === "expired" || state === "unavailable") return "warning";
  return "default";
};

export function TargetedNextRunReceipts({
  receipts,
}: {
  receipts: TargetedNextRunReceiptDto[];
}): JSX.Element | null {
  if (receipts.length === 0) return null;
  const latest = receipts[0]!;
  return <Accordion
    disableGutters
    variant="outlined"
    sx={{ mx: 1.5, mt: 1, borderRadius: "10px !important", "&:before": { display: "none" } }}
  >
    <AccordionSummary aria-controls="targeted-next-run-receipts">
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0, width: "100%" }}>
        <ScheduleSendOutlinedIcon color="action" fontSize="small" />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" fontWeight={750} noWrap>
            Deliver on next run · {latest.recipients.map(recipient => recipient.agentTitle).join(", ")}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            Passive delivery · no Run · no reply requested
          </Typography>
        </Box>
        {receipts.length > 1 ? <Chip size="small" label={`${receipts.length} receipts`} /> : null}
      </Stack>
    </AccordionSummary>
    <AccordionDetails id="targeted-next-run-receipts">
      <Stack spacing={1.25}>
        {receipts.map(receipt => <Box key={receipt.deliveryId}>
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {receipt.text}
          </Typography>
          <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: 0.75 }}>
            {receipt.recipients.map(recipient => <Chip
              key={`${receipt.deliveryId}:${recipient.agentId}`}
              size="small"
              color={stateColor(recipient.state)}
              label={`${recipient.agentTitle}: ${stateLabel(recipient.state)}`}
              title={recipient.unavailableReason}
            />)}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            Scheduled {new Date(receipt.createdAt).toLocaleString()}
          </Typography>
        </Box>)}
      </Stack>
    </AccordionDetails>
  </Accordion>;
}
