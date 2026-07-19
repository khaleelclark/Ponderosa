import type { AgentTelemetryStream } from "@ponderosa/core";

export function telemetryElementId(stream: AgentTelemetryStream, id: string): string {
  return `agent-telemetry-${stream}-${encodeURIComponent(id)}`;
}
