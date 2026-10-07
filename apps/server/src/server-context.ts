import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { AgentDetailDto, AssetLimitsDto, GlobalChatSearchResponseDto, TokenUsageRangeDto, TokenUsageSummaryDto } from "@ponderosa/core";

/**
 * Read-only authority handed to extracted route domains. Every member must be a
 * read or a projection: a route that mutates state belongs with the authority it
 * mutates, or must declare that authority in its own parameter list. `dataDir`
 * is deliberately absent — it is a filesystem write capability, not a read.
 */
export interface ServerContext {
  readonly opts: {
    readonly buildVersion?: string;
    readonly buildRevision?: string;
  };
  readonly limits: Readonly<AssetLimitsDto & { maxAttachmentsPerMessage: number }>;
  readonly agentDetail: (
    agentId: string,
    input?: { limit?: number; cursor?: string; focusId?: string },
  ) => AgentDetailDto | undefined;
  readonly store: Pick<
    AgentStore,
    | "getActivityOutputPage"
    | "getActivityPage"
    | "getAgent"
    | "agentCreationPending"
    | "getAgentDetail"
    | "getAllChatPage"
    | "getArtifactPage"
    | "getResponseFileReview"
    | "getChangedFileDetail"
    | "getChangedFilePage"
    | "getConversation"
    | "getCommunicationEvent"
    | "getProject"
    | "listAgents"
    | "getRunOutputPage"
    | "getRunPage"
    | "getWorkItemPage"
  >;
  readonly tokenUsage: (
    scope: { type: "overall" | "branches"; product?: "dev" | "branches" } | { type: "project" | "branch" | "agent" | "conversation"; id: string; product?: "dev" | "branches" },
    range?: TokenUsageRangeDto,
  ) => TokenUsageSummaryDto;
}

export interface SearchRoutesContext extends ServerContext {
  readonly store: ServerContext["store"] & Pick<AgentStore, "listProjects" | "sqlite">;
  readonly globalChatSearch: (query: {
    product?: "dev" | "branches";
    q?: string;
    limit?: string | number;
    kind?: string;
    distinct?: string;
  }) => GlobalChatSearchResponseDto;
  readonly workspace: Pick<WorkspaceStore, "listDecisionEventPage">;
  readonly coordinationV3: Pick<
    CoordinationV3Store,
    "deliveryReceiptsForCommunications"
  >;
}
