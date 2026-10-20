import type { AgentDto, AgentHealthDto, ConversationMessageDto } from "@ponderosa/core";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Box, ButtonBase, Tooltip } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { formatExecutionElapsed } from "../time";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";
import { messageDeliveryPhase } from "./messageDeliveryPhase";

export function MasterRespondingIndicator({ agents, healthByAgentId, messages }: {
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
  messages: ConversationMessageDto[];
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const latest = new Map<string, NonNullable<ConversationMessageDto["deliveryReceipts"]>[number]>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const receipt of message.deliveryReceipts ?? []) latest.set(receipt.targetAgentId, receipt);
  }
  const pending = [...latest.values()].flatMap(receipt => {
    const phase = messageDeliveryPhase(receipt);
    const activity = healthByAgentId.get(receipt.targetAgentId)?.runtimeActivity;
    if (phase !== "Working" || !activity || activity.executionId !== receipt.executionId) return [];
    return [{ receipt, phase, name: agents.find(agent => agent.id === receipt.targetAgentId)?.title.trim() || "Agent",
      since: activity.startedAt }];
  });
  const ticking = pending.length > 0;
  useEffect(() => {
    if (!ticking) { setOpen(false); return; }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const summary = pending.length === 1 ? `${pending[0]!.name} is working` : `${pending.length} agents are working`;
  const announcement = pending.length ? summary : "No agents are working";
  return <>
    <Box role="status" aria-live="polite" aria-atomic="true"
      sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{announcement}</Box>
    {pending.length ? <Box sx={{ containerType: "inline-size" }}>
      <ChatLiveBanner singleLine>
        <Tooltip describeChild open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} disableTouchListener
          slotProps={{ tooltip: { sx: { maxWidth: "min(360px, calc(100vw - 32px))", p: 1 } } }}
          title={<Box ref={detailsRef} tabIndex={0} onKeyDown={event => { if (event.key === "Escape") triggerRef.current?.focus(); }}
            sx={{ maxHeight: "min(320px, 50vh)", overflowY: "auto", overflowWrap: "anywhere" }}>
            {pending.map(({ receipt, phase, name, since }) => <Box key={receipt.targetAgentId} sx={{ display: "flex", alignItems: "baseline", gap: 0.5, py: 0.25 }}>
              <InfoOutlinedIcon color="info" sx={{ fontSize: 14, flexShrink: 0, alignSelf: "flex-start", mt: 0.25 }} />
              <Box component="span" sx={{ minWidth: 0 }}>{name} — {phase} · {formatExecutionElapsed(since, now)}</Box>
            </Box>)}
          </Box>}>
          <ButtonBase ref={triggerRef} aria-label={summary} aria-expanded={open} onClick={() => setOpen(true)}
            onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); detailsRef.current?.focus(); } }}
            sx={{ minWidth: 0, maxWidth: "100%", color: "inherit", font: "inherit", pointerEvents: "auto", borderRadius: 1,
              "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "info.main", outlineOffset: 2 } }}>
            {pending.length === 1 ? <>
              <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pending[0]!.name}</Box>
              <Box component="span" sx={{ flexShrink: 0, whiteSpace: "pre" }}>{" is working"}</Box>
            </> : <Box component="span" sx={{ whiteSpace: "nowrap" }}>{summary}</Box>}
            <Box component="span" aria-hidden="true" sx={{ ml: 0.75, flexShrink: 0, fontVariantNumeric: "tabular-nums", "@container (max-width: 260px)": { display: "none" } }}>
              · {formatExecutionElapsed(pending.reduce((first, row) => row.since < first ? row.since : first, pending[0]!.since), now)}
            </Box>
          </ButtonBase>
        </Tooltip>
      </ChatLiveBanner>
    </Box> : null}
  </>;
}
