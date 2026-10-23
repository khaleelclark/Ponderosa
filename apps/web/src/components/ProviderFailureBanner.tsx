import type { AgentDto, ConversationMessageDto, MessageDeliveryReceiptDto } from "@ponderosa/core";
import { Alert, Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { ProviderQuotaIndicator } from "./ProviderUsageCenter";
import { useWorkspaceReadOnly } from "./WorkspaceReadOnlyContext";

export function providerFailureHeadline(failure: NonNullable<MessageDeliveryReceiptDto["providerFailure"]>): string {
  const provider = failure.providerId === "codex" ? "Codex" : failure.providerId === "claude" ? "Claude" : "Provider";
  return failure.category === "quota_exhausted" ? `${provider} usage limit reached`
    : failure.category === "throttled" ? `${provider} is temporarily limiting requests`
    : failure.category === "capacity" ? `${provider} is temporarily at capacity` : `${provider} limited this request`;
}

export function ProviderFailureBanner({ messages, agents, projectId, hasMore, onOpenAgent, children }: {
  messages: ConversationMessageDto[]; agents: AgentDto[]; projectId: string; hasMore?: boolean; onOpenAgent?(agentId: string): void; children?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const queryClient = useQueryClient(), readOnly = useWorkspaceReadOnly();
  const work = new Map<string, { receipt: MessageDeliveryReceiptDto; text: string }>();
  for (const message of messages) for (const receipt of message.deliveryReceipts ?? []) {
    if (receipt.providerFailure) work.set(receipt.activationId, { receipt, text: message.text });
  }
  const rows = [...work.values()];
  useEffect(() => { if (!rows.length) setOpen(false); }, [rows.length]);
  const name = (id: string) => agents.find(agent => agent.id === id)?.title || "Agent";
  const providers = [...new Set(rows.flatMap(({ receipt }) => receipt.providerFailure?.providerId ? [receipt.providerFailure.providerId] : []))];
  const first = rows[0]?.receipt.providerFailure;
  const sameFailure = first && rows.every(({ receipt }) => receipt.providerFailure!.providerId === first.providerId && receipt.providerFailure!.category === first.category);
  const count = hasMore ? "100+" : rows.length;
  const providerNames = providers.map(provider => provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "Provider");
  const summary = sameFailure ? providerFailureHeadline(first) + (rows.length > 1 ? ` · ${count} messages` : "")
    : `${providerNames.join(" + ") || "Provider"} interruptions · ${count} messages`;
  const states = [...new Set(rows.map(({ receipt }) => receipt.providerFailure!.recovery))].map(state => ({
    scheduled: "Waiting for a scheduled retry", retrying: "Recovery running", action_required: "User action required", stopped: "Automatic retries stopped",
  })[state]).join(". ");
  const announcement = rows.length ? `${summary}. ${states}.` : "No active provider interruptions";
  const status = <Box role="status" aria-live="polite" aria-atomic="true" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>{announcement}</Box>;
  const recheck = async (provider: string) => {
    setChecking(provider); setNotice(undefined);
    try {
      await api.recheckEngine(provider);
      await queryClient.invalidateQueries({ queryKey: queryKeys.engines.all });
      setNotice("Provider checked. This does not confirm that its usage allowance has reset. Retry retained work explicitly when ready.");
    } catch { setNotice("Could not recheck the provider. The recorded work and recovery state are unchanged."); }
    finally { setChecking(undefined); }
  };
  if (!rows.length) return <>{status}{children}</>;
  return <>
    <Box sx={{ containerType: "inline-size" }}>
      <ChatLiveBanner singleLine>
        <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</Box>
        <ButtonBase onClick={() => setOpen(true)} aria-label={`${summary}. Details`} aria-haspopup="dialog"
          sx={{ ml: 0.75, flexShrink: 0, pointerEvents: "auto", borderRadius: 0.5, textDecoration: "underline", "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "info.main" } }}>Details</ButtonBase>
      </ChatLiveBanner>
      {status}
    </Box>
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle>Provider interruptions</DialogTitle>
      <DialogContent dividers sx={{ overflowWrap: "anywhere" }}>
        <Stack spacing={2}>
          {hasMore ? <Alert severity="warning">Showing the first 100 affected messages. More affected work remains available in Agent activity and All Messages.</Alert> : null}
          {rows.map(({ receipt, text }) => {
            const failure = receipt.providerFailure!;
            return <Box key={receipt.activationId}>
              <Typography fontWeight={700}>{name(receipt.targetAgentId)} — {providerFailureHeadline(failure)}</Typography>
              <Typography variant="body2">{failure.category === "quota_exhausted" ? "The provider reported that the allowance for this work is exhausted."
                : failure.category === "capacity" ? "Provider capacity is unavailable; this does not establish that your subscription allowance is exhausted."
                : failure.category === "throttled" ? "The provider explicitly reported temporary throttling."
                : "Ponderosa cannot yet confirm whether this is temporary throttling or an exhausted allowance."}</Typography>
              <Typography variant="body2">{failure.recovery === "scheduled" ? `Waiting for an automatic retry, eligible ${new Date(failure.nextRetryAt!).toLocaleString()}. Eligibility does not guarantee provider acceptance.`
                : failure.recovery === "retrying" ? "An authorized recovery attempt is running; its outcome is not yet confirmed."
                : failure.recovery === "stopped" ? "Automatic retries stopped. Review this work before trying again."
                : "Automatic recovery requires user action. Review usage, then retry this work explicitly."}</Typography>
              {failure.category === "quota_exhausted" ? <Typography variant="body2">{failure.resetAt ? `Provider-reported reset: ${new Date(failure.resetAt).toLocaleString()}.`
                : "The provider did not report a reset time."}</Typography> : null}
              {failure.quotaLimit ? <Typography variant="body2">Affected allowance: {{ five_hour: "Five-hour", weekly: "Weekly", weekly_model: "Weekly model", extra_usage: "Extra usage" }[failure.quotaLimit]}.</Typography> : null}
              {failure.model ? <Typography variant="caption">Failed Run model: {failure.model}</Typography> : null}
              <Typography variant="body2" sx={{ my: 0.5 }}>Message: {text.length > 240 ? `${text.slice(0, 240)}…` : text}</Typography>
              <MessageDeliveryStatus projectId={projectId} receipts={[receipt]} recipientName={name} onOpenAgent={onOpenAgent} hideCancelAction />
            </Box>;
          })}
          {open ? providers.map(provider => <Stack key={provider} direction="row" useFlexGap flexWrap="wrap" spacing={1}>
            <ProviderQuotaIndicator preferredProvider={provider} renderTrigger={show => <Button onClick={event => show(event.currentTarget)}>View {provider} usage</Button>} />
            {!readOnly ? <Button disabled={Boolean(checking)} onClick={() => void recheck(provider)}>{checking === provider ? "Checking provider…" : `Recheck ${provider}`}</Button> : null}
          </Stack>) : null}
          {notice ? <Alert severity="info">{notice}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={() => setOpen(false)}>Close</Button></DialogActions>
    </Dialog>
  </>;
}
