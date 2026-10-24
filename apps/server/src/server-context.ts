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
    scope: Parameters<AgentStore['getTokenUsage']>[0],
    range?: TokenUsageRangeDto,
  ) => TokenUsageSummaryDto;
}

export interface SearchRoutesContext extends ServerContext {
  readonly store: ServerContext["store"] & Pick<AgentStore, "listProjects" | "listConversations"|'sqlite'>;
  readonly globalChatSearch: (query: {
    q?: string;
    limit?: string | number;
    kind?: string;
    distinct?: string;
    productScope?:'dev'|'branches';
  }) => GlobalChatSearchResponseDto;
  readonly workspace: Pick<WorkspaceStore, "listDecisionEventPage">;
  readonly deliveryReceiptsForCommunications: CoordinationV3Store["deliveryReceiptsForCommunications"];
}
