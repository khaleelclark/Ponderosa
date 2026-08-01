import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type { AgentDetailDto, AssetLimitsDto, GlobalChatSearchResponseDto, TokenUsageRangeDto, TokenUsageSummaryDto } from "@ponderosa/core";
import type { documentationReferences } from "./documentation-reference/index.js";

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
  readonly documentationReferences: typeof documentationReferences;
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
    | "getAgentDetail"
    | "getAllChatPage"
    | "getArtifactPage"
    | "getChangedFileDetail"
    | "getChangedFilePage"
    | "getConversation"
    | "getCommunicationEvent"
    | "getProject"
    | "getRunOutputPage"
    | "getRunPage"
    | "getWorkItemPage"
  >;
  readonly tokenUsage: (
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range?: TokenUsageRangeDto,
  ) => TokenUsageSummaryDto;
}

export interface SearchRoutesContext extends ServerContext {
  readonly globalChatSearch: (query: {
    q?: string;
    limit?: string | number;
    kind?: string;
  }) => GlobalChatSearchResponseDto;
  readonly workspace: Pick<WorkspaceStore, "listDecisionEventPage">;
}
