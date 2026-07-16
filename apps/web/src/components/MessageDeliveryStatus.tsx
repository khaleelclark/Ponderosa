import { Alert, Button, Stack } from "@mui/material";
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
}: {
  receipts?: MessageDeliveryReceiptDto[];
  recipientName(agentId: string): string;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [pendingInjectionId, setPendingInjectionId] = useState<string>();
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
  return <Stack spacing={0.5} sx={{ mt: 0.75 }} aria-label="Message delivery status">
    {receipts.map((receipt) => <Alert
      key={receipt.activationId}
      severity={severity(receipt)}
      variant="outlined"
      role="status"
      action={receipt.canLetCurrentRunFinish && receipt.injectionId ? <Button
        color="inherit"
        size="small"
        disabled={pendingInjectionId === receipt.injectionId}
        onClick={() => void letRunFinish(receipt)}
      >Let current Run finish</Button> : undefined}
      sx={{ py: 0, alignItems: "center", "& .MuiAlert-message": { py: 0.5 } }}
    >
      {deliveryLabel(receipt, recipientName(receipt.targetAgentId), now)}
    </Alert>)}
    {error ? <Alert severity="error">{error}</Alert> : null}
  </Stack>;
}
