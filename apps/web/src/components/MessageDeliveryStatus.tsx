import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import { Alert, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

function deliveryLabel(
  receipt: MessageDeliveryReceiptDto,
  recipientName: string,
  now: number,
): string {
  switch (receipt.state) {
    case "queued": return `Queued for ${recipientName}.`;
    case "steering": return `Steering ${recipientName}; awaiting provider acknowledgement.`;
    case "started": return `Started a Run for ${recipientName}.`;
    case "delivered": return `Delivered to ${recipientName}.`;
    case "processed": return `Processed by ${recipientName}.`;
    case "unconfirmed": {
      const remaining = receipt.recoveryAt
        ? Math.max(0, Math.ceil((Date.parse(receipt.recoveryAt) - now) / 1_000))
        : 0;
      return `Delivery to ${recipientName} is unconfirmed. Interrupting the current Run and recovering ${remaining > 0 ? `in ${remaining}s` : "now"}.`;
    }
    case "waiting_for_run": return `Delivery to ${recipientName} was unconfirmed. Recovery will audit current state after the current Run finishes.`;
    case "recovery_queued": return `Delivery to ${recipientName} was unconfirmed. Recovery is queued and will audit current state first.`;
    case "recovering": return `Delivery to ${recipientName} was unconfirmed. Recovery is running and auditing current state first.`;
    case "recovered": return `Recovered and processed by ${recipientName}.`;
    case "undelivered": return `Undelivered to ${recipientName}: provider acknowledgement was not confirmed.`;
    case "failed": return `Delivery to ${recipientName} failed.`;
    case "cancelled": return `Delivery to ${recipientName} was cancelled.`;
  }
}

function severity(receipt: MessageDeliveryReceiptDto): "success" | "info" | "warning" | "error" {
  if (receipt.state === "delivered" || receipt.state === "processed" || receipt.state === "recovered") return "success";
  if (receipt.state === "unconfirmed" || receipt.state === "waiting_for_run" || receipt.state === "recovery_queued" || receipt.state === "recovering") return "warning";
  if (receipt.state === "undelivered" || receipt.state === "failed") return "error";
  return "info";
}

export function MessageDeliveryStatus({
  receipts,
  recipientName,
  onOpenAgent,
}: {
  receipts?: MessageDeliveryReceiptDto[];
  recipientName(agentId: string): string;
  onOpenAgent?(agentId: string): void;
  onOpenWorkLog?(agentId: string): void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [pendingInjectionId, setPendingInjectionId] = useState<string>();
  const [pendingRetryId, setPendingRetryId] = useState<string>();
  const [confirmRetry, setConfirmRetry] = useState<MessageDeliveryReceiptDto>();
  const [error, setError] = useState<string>();
  const hasCountdown = receipts?.some((receipt) => receipt.state === "unconfirmed" && receipt.recoveryAt) ?? false;
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [hasCountdown]);
  if (!receipts?.length) return null;
  const letRunFinish = async (receipt: MessageDeliveryReceiptDto) => {
    if (!receipt.injectionId) return;
    setError(undefined);
    setPendingInjectionId(receipt.injectionId);
    try {
      await api.letCurrentRunFinish(receipt.injectionId, {
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent", receipt.targetAgentId] }),
        queryClient.invalidateQueries({ queryKey: ["conversation"] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change steering recovery.");
    } finally {
      setPendingInjectionId(undefined);
    }
  };
  const retryDelivery = async (receipt: MessageDeliveryReceiptDto) => {
    setError(undefined);
    setPendingRetryId(receipt.activationId);
    try {
      await api.retryMessageDelivery(receipt.activationId, {
        idempotencyKey: `operator-delivery-retry:${receipt.activationId}`,
      });
      setConfirmRetry(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent", receipt.targetAgentId] }),
        queryClient.invalidateQueries({ queryKey: ["conversation"] }),
        queryClient.invalidateQueries({ queryKey: ["collaboration-chat"] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry message delivery.");
    } finally {
      setPendingRetryId(undefined);
    }
  };
  return <Stack spacing={0.5} sx={{ alignItems: "flex-end", maxWidth: "100%" }} aria-label="Message delivery status">
    {receipts.map((receipt) => {
      const tone = severity(receipt);
      const name = recipientName(receipt.targetAgentId);
      const StatusIcon = tone === "success"
        ? CheckCircleOutlineIcon
        : tone === "warning"
          ? WarningAmberOutlinedIcon
          : tone === "error"
            ? ErrorOutlineIcon
            : InfoOutlinedIcon;
      return <Stack key={receipt.activationId} direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ justifyContent: "flex-end", maxWidth: "100%" }}>
        <ButtonBase
          role="status"
          aria-label={onOpenAgent ? `${deliveryLabel(receipt, name, now)} Open direct chat with ${name}.` : deliveryLabel(receipt, name, now)}
          disabled={!onOpenAgent}
          onClick={() => onOpenAgent?.(receipt.targetAgentId)}
          sx={{
            maxWidth: "100%",
            minHeight: 28,
            px: 0.75,
            py: 0.25,
            borderRadius: 999,
            color: `${tone}.main`,
            bgcolor: (theme) => alpha(theme.palette[tone].main, theme.palette.mode === "dark" ? 0.08 : 0.06),
            cursor: onOpenAgent ? "pointer" : "default",
            "&.Mui-disabled": { color: `${tone}.main`, opacity: 1 },
            "&:hover": onOpenAgent ? { bgcolor: (theme) => alpha(theme.palette[tone].main, theme.palette.mode === "dark" ? 0.14 : 0.1) } : undefined,
          }}
        >
          <StatusIcon sx={{ mr: 0.5, fontSize: 16, flex: "0 0 auto" }} />
          <Typography variant="caption" component="span" sx={{ color: "text.secondary", fontWeight: 650, overflowWrap: "anywhere", textAlign: "right" }}>
            {deliveryLabel(receipt, name, now)}
          </Typography>
        </ButtonBase>
        {receipt.canLetCurrentRunFinish && receipt.injectionId ? <Button
          color="warning"
          variant="text"
          size="small"
          disabled={pendingInjectionId === receipt.injectionId}
          onClick={() => void letRunFinish(receipt)}
          sx={{ minHeight: 28, py: 0.25 }}
        >Let current Run finish</Button> : null}
        {receipt.canRetry ? <Button
          color="error"
          variant="text"
          size="small"
          disabled={pendingRetryId === receipt.activationId}
          onClick={() => receipt.retryMayDuplicate ? setConfirmRetry(receipt) : void retryDelivery(receipt)}
          sx={{ minHeight: 28, py: 0.25 }}
        >{pendingRetryId === receipt.activationId ? "Retrying…" : "Retry"}</Button> : null}
      </Stack>;
    })}
    {error ? <Alert severity="error">{error}</Alert> : null}
    <Dialog
      open={Boolean(confirmRetry)}
      onClose={() => pendingRetryId ? undefined : setConfirmRetry(undefined)}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Retry uncertain delivery?</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          The previous attempt may have reached the provider even though Ponderosa did not receive an acknowledgement. The retry tells the agent to audit current state before repeating any work.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirmRetry(undefined)} disabled={Boolean(pendingRetryId)}>Cancel</Button>
        <Button
          color="warning"
          variant="contained"
          onClick={() => confirmRetry && void retryDelivery(confirmRetry)}
          disabled={Boolean(pendingRetryId)}
        >{pendingRetryId ? "Retrying…" : "Retry anyway"}</Button>
      </DialogActions>
    </Dialog>
  </Stack>;
}
