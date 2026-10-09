import type Database from "better-sqlite3";
import type { PineconeProfileDto, UpdatePineconeAdmissionRequest } from "@ponderosa/core";
import { payloadHash } from "./coordination-v3-canonical-json.js";

/** Uses the canonical connection and caller's creation/deletion transaction. */
export class PineconeProfileStore {
  constructor(private readonly client: Database.Database) {}

  get(agentId: string): PineconeProfileDto | undefined {
    const row = this.client.prepare(`SELECT p.agent_id, p.project_id, p.conversation_id,
      p.guidance_version, p.created_at, p.admission_state, p.revision, p.updated_at FROM pinecone_profiles p
      JOIN agents a ON a.id=p.agent_id AND a.project_id=p.project_id AND a.conversation_id=p.conversation_id
      JOIN conversations c ON c.id=p.conversation_id AND c.project_id=p.project_id
      JOIN projects project ON project.id=p.project_id
      WHERE p.agent_id=? AND a.deleted_at IS NULL AND c.branch_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r
          WHERE r.local_id IN (a.id,c.id) AND r.state!='active')`).get(agentId) as {
        agent_id: string; project_id: string; conversation_id: string;
        guidance_version: 1; created_at: string; admission_state: "active" | "paused";
        revision: number; updated_at: string;
      } | undefined;
    return row ? { agentId: row.agent_id, projectId: row.project_id,
      conversationId: row.conversation_id, guidanceVersion: row.guidance_version,
      createdAt: row.created_at, admissionState: row.admission_state,
      revision: row.revision, updatedAt: row.updated_at } : undefined;
  }

  insert(profile: Pick<PineconeProfileDto, "agentId" | "projectId" | "conversationId" | "guidanceVersion" | "createdAt">): void {
    const owner = this.client.prepare(`SELECT 1 FROM agents a
      JOIN conversations c ON c.id=a.conversation_id AND c.project_id=a.project_id
      JOIN projects project ON project.id=a.project_id
      WHERE a.id=? AND a.project_id=? AND c.id=? AND c.branch_id IS NULL
        AND c.archived=0 AND a.archived=0 AND a.deleted_at IS NULL AND a.manager_agent_id IS NULL
        AND a.spawned_by_agent_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r
          WHERE r.local_id IN (a.id,c.id) AND r.state!='active')`)
      .get(profile.agentId, profile.projectId, profile.conversationId);
    if (!owner) throw new Error("Pinecone requires an active ordinary root Agent in a live Dev Chat");
    if (this.client.prepare("SELECT 1 FROM pinecone_profiles WHERE conversation_id=?").get(profile.conversationId)) {
      throw new Error("This Chat already has Pinecone. Open or restore that Agent, or delete it before creating a replacement.");
    }
    this.client.prepare(`INSERT INTO pinecone_profiles
      (agent_id,project_id,conversation_id,guidance_version,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(profile.agentId, profile.projectId, profile.conversationId, profile.guidanceVersion, profile.createdAt, profile.createdAt);
  }

  updateAdmission(agentId: string, input: UpdatePineconeAdmissionRequest, now = new Date().toISOString()): PineconeProfileDto {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !["admissionState", "expectedRevision", "operationKey"].includes(key)) ||
        !["active", "paused"].includes(input.admissionState) ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
        typeof input.operationKey !== "string" || input.operationKey !== input.operationKey.trim() ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(input.operationKey)) {
      throw Object.assign(new Error("Invalid Pinecone admission update"), { statusCode: 400 });
    }
    return this.client.transaction(() => {
      const current = this.get(agentId);
      if (!current || !this.client.prepare(`SELECT 1 FROM agents a JOIN conversations c ON c.id=a.conversation_id
        WHERE a.id=? AND a.archived=0 AND c.archived=0 AND a.deleted_at IS NULL`).get(agentId)) {
        throw Object.assign(new Error("Live Pinecone profile not found"), { statusCode: 404 });
      }
      const hash = payloadHash({ agentId, projectId: current.projectId, conversationId: current.conversationId,
        admissionState: input.admissionState, expectedRevision: input.expectedRevision });
      const receipt = this.client.prepare(`SELECT payload_hash, result_json FROM pinecone_admission_receipts
        WHERE agent_id=? AND operation_key=?`).get(agentId, input.operationKey) as { payload_hash: string; result_json: string } | undefined;
      if (receipt) {
        if (receipt.payload_hash !== hash) throw Object.assign(new Error("Pinecone operation key conflicts with its original payload"), { statusCode: 409 });
        return JSON.parse(receipt.result_json) as PineconeProfileDto;
      }
      if (current.revision !== input.expectedRevision) {
        throw Object.assign(new Error("Pinecone changed. Reload its current state and review before acting."), { statusCode: 409 });
      }
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw Object.assign(new Error("Pinecone revision exhausted"), { statusCode: 409 });
      const result: PineconeProfileDto = { ...current, admissionState: input.admissionState, revision: current.revision + 1, updatedAt: now };
      this.client.prepare(`UPDATE pinecone_profiles SET admission_state=?,revision=?,updated_at=? WHERE agent_id=? AND revision=?`)
        .run(result.admissionState, result.revision, now, agentId, current.revision);
      this.client.prepare(`INSERT INTO pinecone_admission_receipts
        (agent_id,project_id,conversation_id,operation_key,payload_hash,result_json,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(agentId, current.projectId, current.conversationId, input.operationKey, hash, JSON.stringify(result), now);
      return result;
    })();
  }
}
