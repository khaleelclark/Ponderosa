import type {
  AgentDto,
  AgentHealthDto,
  AgentMessageChannel,
  ConversationDto,
  EngineDto,
  ProjectEngineCapabilitiesDto,
} from "@ponderosa/core";
import type { AgentStatus } from "../agents";
import type { AgentDetailView, AgentTelemetryFocus } from "../routing";

export interface AgentDetailProps {
  agentId: string;
  projectId: string;
  auditOnly?: boolean;
  focusMessageId?: string;
  focusTelemetry?: AgentTelemetryFocus;
  technicalFocusId?: string;
  initialView?: AgentDetailView;
  triggerSettingsId?: string;
  onViewChange?(view: AgentDetailView): void;
  onOpenTechnicalDetails(focusId?: string): void;
  engines: EngineDto[];
  modelCatalogLoading?: boolean;
  engineCapabilities: ProjectEngineCapabilitiesDto[];
  onRefreshCapabilities(context?: {
    engineId?: string;
    model?: string;
    agentId?: string;
  }): Promise<unknown> | unknown;
  projectedStatus?: AgentStatus;
  projectedHealth?: AgentHealthDto;
  statusByAgentId: ReadonlyMap<string, AgentStatus>;
  healthByAgentId: ReadonlyMap<string, AgentHealthDto>;
  agents: AgentDto[];
  conversations: ConversationDto[];
  onOpenProject(): void;
  onOpenAgent(agentId: string): void;
  onOpenAgentSettings(agentId: string): void;
  onOpenCommunicationSource(
    conversationId: string,
    communicationEventId: string,
    channel: Extract<AgentMessageChannel, "main" | "collaboration">,
  ): void;
  onOpenMaster(conversationId: string): void;
  onOpenArtifact(artifactId: string): void;
  onOpenReview(path?: string, executionId?: string): void;
  onOpenBrowser(runId: string): void;
  onNewSubagent(managerAgentId: string): void;
  onCreateTrigger(): void;
  onDeleted(deletedAgentIds: string[]): void;
  onAgentsDeleted(agentIds: string[]): void;
}
