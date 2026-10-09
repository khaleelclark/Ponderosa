/** Configuration over an ordinary Chat-owned Agent; never a second runtime. */
export interface PineconeProfileDto {
  agentId: string;
  projectId: string;
  conversationId: string;
  guidanceVersion: 1;
  createdAt: string;
  admissionState: "active" | "paused";
  revision: number;
  updatedAt: string;
}
export const PINECONE_GUIDANCE_VERSION = 1 as const;
export const PINECONE_PRESET_ID = "builtin:pinecone:1";

export interface UpdatePineconeAdmissionRequest {
  admissionState: "active" | "paused";
  expectedRevision: number;
  operationKey: string;
}
