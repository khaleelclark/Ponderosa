import type { AgentStore } from "@ponderosa/agents";
import type { AssetLimitsDto, TokenUsageRangeDto, TokenUsageSummaryDto } from "@ponderosa/core";
import type { documentationReferences } from "./documentation-reference/index.js";

export interface ServerContext {
  opts: {
    buildVersion?: string;
    buildRevision?: string;
    dataDir: string;
  };
  documentationReferences: typeof documentationReferences;
  limits: Readonly<AssetLimitsDto & { maxAttachmentsPerMessage: number }>;
  readonly store: Pick<AgentStore, "getAgentDetail" | "getProject">;
  readonly tokenUsage: (
    scope: { type: "overall" } | { type: "project" | "agent"; id: string },
    range?: TokenUsageRangeDto,
  ) => TokenUsageSummaryDto;
}
