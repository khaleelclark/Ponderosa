import type { AssetLimitsDto } from "@ponderosa/core";
import type { documentationReferences } from "./documentation-reference/index.js";

export interface ServerContext {
  opts: {
    buildVersion?: string;
    buildRevision?: string;
    dataDir: string;
  };
  documentationReferences: typeof documentationReferences;
  limits: Readonly<AssetLimitsDto & { maxAttachmentsPerMessage: number }>;
}
