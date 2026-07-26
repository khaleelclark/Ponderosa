import type {
  AgentDto,
  AgentHealthDto,
  ConversationDto,
  EngineDto,
  ProjectEngineCapabilitiesDto,
} from "@ponderosa/core";
import type { AgentStatus } from "../agents";
import type { AgentDetailView, AgentTelemetryFocus } from "../routing";

export interface AgentDetailProps {
  agentId: string;
  focusMessageId?: string;
  focusTelemetry?: AgentTelemetryFocus;
  technicalFocusId?: string;
  initialView?: AgentDetailView;
  createTrigger?: boolean;
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
  onOpenBroadcast(conversationId: string, communicationEventId: string): void;
  onOpenMaster(conversationId: string): void;
  onOpenArtifact(artifactId: string): void;
  onOpenArtifactInNewTab(artifactId: string): void;
  onOpenReview(path?: string): void;
  onOpenReviewInNewTab(path?: string): void;
  onOpenBrowser(runId: string): void;
  onNewSubagent(managerAgentId: string): void;
  onDeleted(): void;
}
