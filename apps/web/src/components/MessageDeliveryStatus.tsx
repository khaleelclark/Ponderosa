import {useWorkspaceReadOnly} from "./WorkspaceReadOnlyContext";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import { Alert, Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Tooltip, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";

import { messageDeliveryPhase } from "./messageDeliveryPhase";

function runtimeLabel(receipt: MessageDeliveryReceiptDto): string | undefined {
  const runtime = receipt.runtime;
  if (!runtime) return undefined;
  const effort = runtime.effort
    ? `${runtime.effort === "xhigh" ? "Extra high" : runtime.effort[0]!.toLocaleUpperCase() + runtime.effort.slice(1)} reasoning`
    : "Default reasoning";
  const speed = runtime.speed === "priority"
    ? "Fast"
    : runtime.speed === "standard" || !runtime.speed
      ? "Normal speed"
      : runtime.speed;
  return `${runtime.model ?? runtime.engine ?? "Default model"} · ${effort} · ${speed}`;
}

function deliveryLabel(
  receipt: MessageDeliveryReceiptDto,
  recipientName: string,
  now: number,
): string {
  const waiting = deliveryWaitLabel(receipt);
  if (waiting) return receipt.steeringWaitReason
    ? `Steer for ${recipientName}: ${waiting.detail} Provider acceptance does not guarantee immediate reconsideration or stop a running tool.`
    : `Message for ${recipientName}: ${waiting.detail}`;
  switch (receipt.state) {
    case "queued": return `Queued for ${recipientName}.`;
    case "preparing": return `Preparing a Run for ${recipientName}.`;
    case "retrying": return `Retrying delivery to ${recipientName}.`;
    case "steering": return `Steering ${recipientName}; awaiting provider acknowledgement.`;
    case "started": return `Started a Run for ${recipientName}.`;
    case "delivered": return receipt.injectionKind === "steer" && receipt.providerAcknowledged
      ? `Instructions delivered to ${recipientName}'s active Run. This confirms delivery, not completion.`
      : `Delivered to ${recipientName}.`;
    case "run_unconfirmed": return `Message delivered to ${recipientName}, but Ponderosa lost contact before confirming whether the work finished. Check ${recipientName}'s activity before asking it to try again.`;
    case "processed": return `Processed by ${recipientName}.`;
    case "unconfirmed": {
      const remaining = receipt.recoveryAt
        ? Math.max(0, Math.ceil((Date.parse(receipt.recoveryAt) - now) / 1_000))
        : 0;
      return `${receipt.providerAcknowledged ? `Message delivered to ${recipientName}, but whether the work finished is unconfirmed` : `Delivery to ${recipientName} is unconfirmed`}. Interrupting the current Run and recovering ${remaining > 0 ? `in ${remaining}s` : "now"}.`;
    }
    case "waiting_for_run": return `${receipt.providerAcknowledged ? `Message delivered to ${recipientName}, but whether the work finished is unconfirmed` : `Delivery to ${recipientName} was unconfirmed`}. Recovery will audit current state after the current Run finishes.`;
    case "recovery_queued": return `${receipt.providerAcknowledged ? `Message delivered to ${recipientName}, but whether the work finished is unconfirmed` : `Delivery to ${recipientName} was unconfirmed`}. Recovery is queued and will audit current state first.`;
    case "recovering": return `${receipt.providerAcknowledged ? `Message delivered to ${recipientName}, but whether the work finished is unconfirmed` : `Delivery to ${recipientName} was unconfirmed`}. Recovery is running and auditing current state first.`;
    case "recovered": return `Recovered and processed by ${recipientName}.`;
    case "undelivered": return `Undelivered to ${recipientName}: provider acknowledgement was not confirmed.`;
    case "retry_exhausted": return `Required reply from ${recipientName} was not published after ${receipt.attemptCount} attempts; automatic recovery stopped.`;
    case "failed": return receipt.providerAcknowledged
      ? `Message delivered to ${recipientName}, but the follow-up failed or could not confirm whether the work finished. Check ${recipientName}'s activity before trying again.`
      : `Delivery to ${recipientName} failed.`;
    case "cancelled": return receipt.providerAcknowledged
      ? `Message delivered to ${recipientName}. ${receipt.runStopState === "stopped" ? "This work was stopped." : receipt.runStopState === "stopping" ? "Stopping this work; termination has not been confirmed yet." : "The follow-up was cancelled, but whether its work stopped is unconfirmed."} Changes made before stopping may remain; review the Agent's work before trying again.`
      : `Delivery to ${recipientName} was cancelled.`;
  }
}

function compactDeliveryLabel(receipt: MessageDeliveryReceiptDto): string {
  const waiting = deliveryWaitLabel(receipt);
  if (waiting) return waiting.compact;
  const phase = messageDeliveryPhase(receipt);
  if (phase) return phase;
  switch (receipt.state) {
    case "queued": return "Queued";
    case "preparing": return "Preparing";
    case "retrying": return "Retrying";
    case "steering": return "Steering";
    case "started": return "Started";
    case "delivered": return "Delivered";
    case "run_unconfirmed": return "Work unconfirmed";
    case "processed": return "Processed";
    case "unconfirmed": return receipt.providerAcknowledged ? "Work unconfirmed" : "Delivery unconfirmed";
    case "waiting_for_run": return "Waiting";
    case "recovery_queued": return "Recovery queued";
    case "recovering": return "Recovering";
    case "recovered": return "Recovered";
    case "undelivered": return "Undelivered";
    case "retry_exhausted": return "Reply exhausted";
    case "failed": return receipt.providerAcknowledged ? "Follow-up failed" : "Failed";
    case "cancelled": return receipt.providerAcknowledged ? receipt.runStopState === "stopped" ? "Stopped" : receipt.runStopState === "stopping" ? "Stopping" : "Stop unconfirmed" : "Cancelled";
  }
}

function deliveryWaitLabel(receipt: MessageDeliveryReceiptDto): { compact: string; detail: string } | undefined {
  if (receipt.state !== "queued" && receipt.state !== "retrying") return undefined;
  switch (receipt.steeringWaitReason) {
    case "context_refresh": return { compact: "Waiting for context refresh", detail: "waiting for context refresh to finish." };
    case "prior_steering": return { compact: "Waiting for earlier steer", detail: "an earlier steer is awaiting provider acknowledgement." };
    case "revision_pending": return { compact: "Saving message edit", detail: "waiting for the message edit to be durably recorded." };
    case "provider_not_ready": return { compact: "Waiting for provider", detail: "the provider was not ready to accept steering; another attempt is scheduled." };
    case "provider_unsupported": return { compact: "Provider cannot steer", detail: "the provider reported that steering is unsupported; these instructions have not been acknowledged." };
    case "preparation_retry": return { compact: "Retrying steer preparation", detail: "prompt preparation did not finish; another attempt is scheduled." };
    case "run_starting": return { compact: "Waiting for Run startup", detail: "the target Run is still starting." };
    case "scheduler_pending": return { compact: "Steer pending", detail: "awaiting scheduler admission; no provider acknowledgement yet." };
    default: break;
  }
  switch (receipt.queueWaitReason) {
    case "host_resource_pressure": return { compact: "Waiting for host resources", detail: "host-resource protection is holding new work." };
    case "provider_disabled": return { compact: "Provider disabled", detail: "the selected provider is disabled; this message has not started." };
    case "authentication_unknown": return { compact: "Checking provider sign-in", detail: "provider sign-in has not been confirmed." };
    case "authentication_required": return { compact: "Provider sign-in required", detail: "the selected provider requires sign-in." };
    case "provider_unavailable": return { compact: "Waiting for provider", detail: "the selected provider is unavailable." };
    case "current_run": return { compact: "Waiting for current Run", detail: "the recipient's current Run must finish before this delivery starts." };
    case "provider_retry": return { compact: "Waiting to retry provider", detail: "the existing provider retry hold is retaining this work." };
    default: return undefined;
  }
}

function severity(receipt: MessageDeliveryReceiptDto): "success" | "info" | "warning" | "error" {
  if (messageDeliveryPhase(receipt) === "Working") return "info";
  if (receipt.state === "delivered" || receipt.state === "processed" || receipt.state === "recovered") return "success";
  if (receipt.state === "retrying" || receipt.state === "run_unconfirmed" || receipt.state === "unconfirmed" || receipt.state === "waiting_for_run" || receipt.state === "recovery_queued" || receipt.state === "recovering" || (receipt.state === "cancelled" && receipt.providerAcknowledged)) return "warning";
  if (receipt.state === "undelivered" || receipt.state === "retry_exhausted" || receipt.state === "failed") return "error";
  return "info";
}

export function MessageDeliveryStatus({
  projectId,
  receipts,
  recipientName,
  onOpenAgent,
  compact = false,
  compactSuccess = false,
  compactSuccessTooltip = true,
  hideCancelAction = false,
}: {
  projectId?: string;
  receipts?: MessageDeliveryReceiptDto[];
  recipientName(agentId: string): string;
  onOpenAgent?(agentId: string): void;
  compact?: boolean;
  compactSuccess?: boolean;
  compactSuccessTooltip?: boolean;
  hideCancelAction?: boolean;
}): JSX.Element | null {
  const readOnly=useWorkspaceReadOnly();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [pendingInjectionId, setPendingInjectionId] = useState<string>();
  const [pendingRetryId, setPendingRetryId] = useState<string>();
  const [pendingCancelId, setPendingCancelId] = useState<string>();
  const [confirmRetry, setConfirmRetry] = useState<MessageDeliveryReceiptDto>();
  const [error, setError] = useState<string>();
  const hasCountdown = receipts?.some((receipt) => receipt.state === "unconfirmed" && receipt.recoveryAt) ?? false;
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [hasCountdown]);
  if (!receipts?.length) return null;
  const allSuccessful = receipts.every(receipt => severity(receipt) === "success");
  const showSteeringDelivery = receipts.some(receipt => receipt.injectionKind === "steer" &&
    receipt.providerAcknowledged && receipt.state === "delivered");
  if (compact || (!showSteeringDelivery && compactSuccess && allSuccessful)) {
    const tones = receipts.map(receipt =>
      receipt.state === "queued"
        ? "warning"
        : receipt.state === "cancelled" && !receipt.providerAcknowledged
          ? "error"
          : severity(receipt),
    );
    const tone = tones.includes("error")
      ? "error"
      : tones.includes("warning")
        ? "warning"
        : tones.includes("info")
          ? "info"
          : "success";
    const StatusIcon = tone === "success"
      ? CheckCircleOutlineIcon
      : tone === "warning"
        ? WarningAmberOutlinedIcon
        : tone === "error"
          ? ErrorOutlineIcon
          : InfoOutlinedIcon;
    const label = receipts
      .map(receipt => {
        const delivery = deliveryLabel(
          receipt,
          recipientName(receipt.targetAgentId),
          now,
        );
        const runtime = receipt.state === "started" ? runtimeLabel(receipt) : undefined;
        return runtime ? `${delivery} ${runtime}.` : delivery;
      })
      .join(" ");
    const compactLabel = receipts.map(compactDeliveryLabel).join(". ");
    const indicator = (
      <Box
        component="span"
        role="status"
        aria-label={compact || compactSuccessTooltip ? label : compactLabel}
        tabIndex={compact ? 0 : undefined}
        onClick={compact ? event => event.stopPropagation() : undefined}
        sx={compact ? {
          width: 28,
          height: 28,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
        } : undefined}
      >
        <StatusIcon sx={{ fontSize: 14, color: `${tone}.main` }} />
      </Box>
    );
    const compactIndicator = compact || compactSuccessTooltip
      ? <Tooltip title={label}>{indicator}</Tooltip>
      : indicator;
    return showSteeringDelivery ? <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap", maxWidth: "100%" }}>
      {compactIndicator}
      {receipts.filter(receipt => receipt.injectionKind === "steer" && receipt.providerAcknowledged && receipt.state === "delivered")
        .map(receipt => <Typography key={receipt.activationId} variant="caption" sx={{ overflowWrap: "anywhere", color: "text.secondary" }}>
          Instructions delivered to {recipientName(receipt.targetAgentId)}
        </Typography>)}
    </Box> : compactIndicator;
  }
  const letRunFinish = async (receipt: MessageDeliveryReceiptDto) => {
    if (!receipt.injectionId) return;
    setError(undefined);
    setPendingInjectionId(receipt.injectionId);
    try {
      await api.letCurrentRunFinish(receipt.injectionId, {
        idempotencyKey: createClientId(),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(receipt.targetAgentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change steering recovery.");
    } finally {
      setPendingInjectionId(undefined);
    }
  };
  const retryDelivery = async (receipt: MessageDeliveryReceiptDto) => {
    if (!projectId) return;
    setError(undefined);
    setPendingRetryId(receipt.activationId);
    try {
      await api.retryMessageDelivery(projectId, receipt.activationId, {
        idempotencyKey: `operator-delivery-retry:${receipt.activationId}`,
      });
      setConfirmRetry(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(receipt.targetAgentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collaborationAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not retry message delivery.");
    } finally {
      setPendingRetryId(undefined);
    }
  };
  const cancelDelivery = async (receipt: MessageDeliveryReceiptDto) => {
    if (!projectId) return;
    setError(undefined);
    setPendingCancelId(receipt.activationId);
    try {
      await api.cancelMessageDelivery(projectId, receipt.activationId, {
        idempotencyKey: `operator-delivery-cancel:${receipt.activationId}`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(receipt.targetAgentId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collaborationAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel message delivery.");
    } finally {
      setPendingCancelId(undefined);
    }
  };
  return <Stack spacing={0.5} sx={{ alignItems: "flex-end", maxWidth: "100%" }} aria-label="Message delivery status">
    <Box component="span" role="status" aria-live="polite" sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
      {receipts.map(receipt => deliveryLabel(receipt, recipientName(receipt.targetAgentId), now)).join(" ")}
    </Box>
    {receipts.map((receipt) => {
      const tone = severity(receipt);
      const name = recipientName(receipt.targetAgentId);
      const label = deliveryLabel(receipt, name, now);
      const runtime = receipt.state === "started" ? runtimeLabel(receipt) : undefined;
      const detailedLabel = runtime ? `${label} ${runtime}.` : label;
      const StatusIcon = tone === "success"
        ? CheckCircleOutlineIcon
        : tone === "warning"
          ? WarningAmberOutlinedIcon
          : tone === "error"
            ? ErrorOutlineIcon
            : InfoOutlinedIcon;
      const shortLabel = receipt.state === "delivered" && receipt.injectionKind === "steer" && receipt.providerAcknowledged
        ? `Instructions delivered to ${name}`
        : receipt.state === "cancelled" && receipt.providerAcknowledged
        ? `Delivered · ${compactDeliveryLabel(receipt)}`
        : compactDeliveryLabel(receipt);
      return <Stack key={receipt.activationId} direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ justifyContent: "flex-end", maxWidth: "100%", "& > .MuiButton-root": { minWidth: 0, px: { xs: 0.5, sm: 1 }, whiteSpace: "nowrap", fontSize: { xs: 11, sm: 13 }, "@media (pointer: coarse)": { minHeight: 44 } } }}>
        <Tooltip title={detailedLabel}>
          <Box component="span" sx={{ display: "inline-flex", minWidth: 0, maxWidth: "100%" }}>
            <ButtonBase
              aria-label={onOpenAgent ? `${detailedLabel} Open direct chat with ${name}.` : detailedLabel}
              title={runtime}
              disabled={!onOpenAgent}
              onClick={() => onOpenAgent?.(receipt.targetAgentId)}
              sx={{
                maxWidth: "100%",
                minHeight: 28,
                p: 0,
                borderRadius: 999,
                color: `${tone}.main`,
                cursor: onOpenAgent ? "pointer" : "default",
                "&.Mui-disabled": { color: `${tone}.main`, opacity: 1 },
                "&:hover [data-delivery-status-badge]": onOpenAgent ? { bgcolor: (theme) => alpha(theme.palette[tone].main, theme.palette.mode === "dark" ? 0.14 : 0.1) } : undefined,
                "@media (pointer: coarse)": { minHeight: 44 },
              }}
            >
              <Box component="span" data-delivery-status-badge sx={{
                display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: "100%",
                minHeight: 28, px: 0.75, py: 0.25, borderRadius: 999,
                bgcolor: (theme) => alpha(theme.palette[tone].main, theme.palette.mode === "dark" ? 0.08 : 0.06),
              }}>
                <StatusIcon sx={{ mr: 0.5, fontSize: 16, flex: "0 0 auto" }} />
                {receipts.length > 1 ? <Typography variant="caption" component="span" sx={{ display: { xs: "none", sm: "inline" }, color: "text.secondary", fontWeight: 650, minWidth: 0, maxWidth: "20ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", mr: 0.5 }}>
                  {name} ·
                </Typography> : null}
                <Typography variant="caption" component="span" sx={{ color: "text.secondary", fontWeight: 650, overflowWrap: "anywhere" }}>
                  {shortLabel}
                </Typography>
              </Box>
            </ButtonBase>
          </Box>
        </Tooltip>
        {!readOnly && receipt.canLetCurrentRunFinish && receipt.injectionId ? <Button
          color="warning"
          variant="text"
          size="small"
          disabled={pendingInjectionId === receipt.injectionId}
          onClick={() => void letRunFinish(receipt)}
          sx={{ minHeight: 28, py: 0.25 }}
        >Let Current Run Finish</Button> : null}
        {!readOnly && receipt.canRetry && projectId ? <Button
          color="error"
          variant="text"
          size="small"
          disabled={pendingRetryId === receipt.activationId}
          onClick={() => receipt.retryMayDuplicate ? setConfirmRetry(receipt) : void retryDelivery(receipt)}
          sx={{ minHeight: 28, py: 0.25 }}
        >{pendingRetryId === receipt.activationId ? "Trying Again…" : receipt.providerAcknowledged ? "Try Work Again" : "Try Delivery Again"}</Button> : null}
        {!readOnly && !hideCancelAction && receipt.canRetry && projectId ? <Button
          color="inherit"
          variant="text"
          size="small"
          disabled={pendingCancelId === receipt.activationId}
          onClick={() => void cancelDelivery(receipt)}
          sx={{ minHeight: 28, py: 0.25 }}
        >{pendingCancelId === receipt.activationId ? "Dismissing…" : receipt.providerAcknowledged ? "Dismiss" : "Cancel Delivery"}</Button> : null}
      </Stack>;
    })}
    {error ? <Alert severity="error">{error}</Alert> : null}
    <Dialog
      open={Boolean(confirmRetry)}
      onClose={() => pendingRetryId ? undefined : setConfirmRetry(undefined)}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{confirmRetry?.providerAcknowledged ? "Ask the Agent to try the work again?" : "Try delivering this message again?"}</DialogTitle>
      <DialogContent>
        <Typography variant="body2">
          {confirmRetry?.providerAcknowledged
            ? "The message reached the Agent, but Ponderosa could not confirm whether the work finished. Check the Agent’s activity first. Trying again asks the Agent to check its current state, but it may repeat work already completed."
            : "Ponderosa could not confirm whether the provider received the previous attempt. Trying again asks the Agent to check its current state before repeating any work, but duplicate work is still possible."}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirmRetry(undefined)} disabled={Boolean(pendingRetryId)}>Cancel</Button>
        <Button
          color="warning"
          variant="contained"
          onClick={() => confirmRetry && void retryDelivery(confirmRetry)}
          disabled={Boolean(pendingRetryId)}
        >{pendingRetryId ? "Trying Again…" : "Try Again Anyway"}</Button>
      </DialogActions>
    </Dialog>
  </Stack>;
}
