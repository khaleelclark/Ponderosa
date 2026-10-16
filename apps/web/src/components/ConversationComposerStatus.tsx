import type { AgentDto, AgentHealthDto } from "@ponderosa/core";
import { Box, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { formatExecutionElapsed } from "../time";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";

export function MasterRespondingIndicator({
  agents,
  healthByAgentId,
}: {
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const responding = agents.flatMap(agent => {
    const activity = healthByAgentId.get(agent.id)?.runtimeActivity;
    return activity ? [{ agent, activity }] : [];
  });
  if (responding.length === 0) return null;
  const names = responding.map(({ agent }) => agent.title).join(", ");
  const earliest = responding
    .map(({ activity }) => activity.startedAt)
    .sort()[0]!;
  const evidence = responding.map(({ agent, activity }) => activity.lastActivityAt
    ? `${agent.title}: last execution activity ${formatExecutionElapsed(activity.lastActivityAt, now)} ago. Quiet output is not a failure.`
    : `${agent.title}: execution is active; no execution activity has been received yet.`).join(" ");
  return (
    <ChatLiveBanner>
      <Tooltip title={evidence}>
      <Box component="span" tabIndex={0} aria-label={`${names} working. ${evidence}`}>
      {names} {responding.length === 1 ? "is" : "are"} working ·{" "}
      <Box component="span" sx={{ fontVariantNumeric: "tabular-nums", fontKerning: "none", whiteSpace: "nowrap" }}>
        {formatExecutionElapsed(earliest, now)}
      </Box>
      </Box>
      </Tooltip>
    </ChatLiveBanner>
  );
}
