import type { AgentDto, AgentHealthDto, ConversationMessageDto } from "@ponderosa/core";
import { Box, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { formatExecutionElapsed } from "../time";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";
import { messageDeliveryPhase } from "./messageDeliveryPhase";

export function MasterRespondingIndicator({ agents, healthByAgentId, messages }: {
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
  messages: ConversationMessageDto[];
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  const latest = new Map<string, NonNullable<ConversationMessageDto["deliveryReceipts"]>[number]>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const receipt of message.deliveryReceipts ?? []) latest.set(receipt.targetAgentId, receipt);
  }
  const pending = [...latest.values()].flatMap(receipt => {
    const phase = messageDeliveryPhase(receipt);
    const activity = healthByAgentId.get(receipt.targetAgentId)?.runtimeActivity;
    if (!phase || (phase === "Working" && activity?.executionId !== receipt.executionId)) return [];
    return [{ receipt, phase, name: agents.find(agent => agent.id === receipt.targetAgentId)?.title ?? "Agent",
      since: phase === "Working" ? activity!.startedAt : receipt.updatedAt }];
  });
  const ticking = pending.length > 0;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  if (!pending.length) return null;
  return <ChatLiveBanner>
    <Tooltip title="Status follows this message’s delivery. Working requires provider acknowledgement on its exact active execution; quiet output is not a failure.">
      <Box component="span" tabIndex={0} role="status">
        {pending.map(({ receipt, phase, name, since }) => <Box component="span" key={receipt.activationId} sx={{ mr: 1 }}>
          {name} · {phase} · <Box component="span" sx={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {formatExecutionElapsed(since, now)}
          </Box>
        </Box>)}
      </Box>
    </Tooltip>
  </ChatLiveBanner>;
}
