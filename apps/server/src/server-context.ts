import type { documentationReferences } from "./documentation-reference/index.js";

export interface ServerContext {
  opts: {
    buildVersion?: string;
    buildRevision?: string;
  };
  documentationReferences: typeof documentationReferences;
}
