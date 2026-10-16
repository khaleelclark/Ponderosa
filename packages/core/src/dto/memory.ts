/** Canonical memory data, not host policy or factual confidence. Foundation only. */
export type MemoryScope = { kind: "project"; projectId: string } | { kind: "global"; principalId: string };
export type MemorySourceClassification = "user_statement" | "agent_inference";
export interface MemorySourceReference {
  kind: "communication" | "artifact";
  id: string;
  revision: string;
  sha256: string;
}
export interface MemoryAuthor {
  kind: "operator" | "agent";
  id: string;
  agentId?: string;
  runId?: string;
}
export interface MemoryRevisionDto {
  memoryId: string;
  revision: number;
  text: string;
  textHash: string;
  author: MemoryAuthor;
  classification: MemorySourceClassification;
  sources: MemorySourceReference[];
  createdAt: string;
  expiresAt?: string;
  priorRevision?: number;
}
export interface MemoryDto extends MemoryRevisionDto {
  scope: MemoryScope;
  generation: number;
  updatedAt: string;
  /** FTS is transactional lexical retrieval; external indexing is unimplemented. */
  lexicalIndex: "transactional";
  /** Canonical provenance exists, including unreadable references. Not source
   * authorization. Older producers may omit it; consumers must fail closed. */
  sourceBacked?: boolean;
}
export interface MemoryCommandReceipt {
  memoryId: string;
  revision: number;
  generation: number;
  operation: "save" | "update" | "forget";
}
