import type { AgentStore, WorkspaceStore } from "@ponderosa/agents";
import type { AgentDetailDto, AssetLimitsDto, GlobalChatSearchResponseDto, TokenUsageRangeDto, TokenUsageSummaryDto } from "@ponderosa/core";
import type { documentationReferences } from "./documentation-reference/index.js";

export interface ServerContext {
  opts: {
    buildVersion?: string;
    buildRevision?: string;
    dataDir: string;
  };
  documentationReferences: typeof documentationReferences;
  limits: Readonly<AssetLimitsDto & { maxAttachmentsPerMessage: number }>;
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
  readonly globalChatSearch: (query: { q?: string; limit?: string | number }) => GlobalChatSearchResponseDto;
  readonly workspace: Pick<WorkspaceStore, "listDecisionEventPage">;
}
