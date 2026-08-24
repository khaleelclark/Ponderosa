import { Box } from "@mui/material";
import type { AgentHealthDto } from "@ponderosa/core";
import type { AgentStatus } from "../agents";
import {
  agentStatusColor,
  agentStatusPresentation,
  type AgentStatusConnection,
} from "../agents";

interface AgentStatusIndicatorProps {
  status: AgentStatus;
  health?: AgentHealthDto;
  connectionStatus?: AgentStatusConnection;
  phaseEvidenceFresh?: boolean;
  agentNameForId?: (agentId: string) => string | undefined;
}

export function AgentStatusIndicator({
  status,
  health,
  connectionStatus,
  phaseEvidenceFresh,
  agentNameForId,
}: AgentStatusIndicatorProps): JSX.Element {
  const color = agentStatusColor(status);
  const presentation = agentStatusPresentation(health, {
    status,
    connectionStatus,
    phaseEvidenceFresh,
    agentNameForId,
  });

  return (
    <Box
      component="span"
      role="img"
      title={presentation.detail}
      aria-label={presentation.accessibleLabel}
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
