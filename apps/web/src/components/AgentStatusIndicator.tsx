import { Box } from "@mui/material";
import type { AgentStatus } from "../agents";
import { agentStatusColor, agentStatusLabel } from "../agents";

interface AgentStatusIndicatorProps {
  status: AgentStatus;
}

export function AgentStatusIndicator({
  status,
}: AgentStatusIndicatorProps): JSX.Element {
  const color = agentStatusColor(status);
  const label = agentStatusLabel(status);

  return (
    <Box
      title={label}
      aria-label={label}
      sx={{
        width: 9,
        height: 9,
        borderRadius: "50%",
        bgcolor: color === "default" ? "text.disabled" : `${color}.main`,
        flex: "0 0 auto",
      }}
    />
  );
}
