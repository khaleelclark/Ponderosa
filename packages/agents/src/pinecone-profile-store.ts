import type Database from "better-sqlite3";
import type { PineconeProfileDto } from "@ponderosa/core";

/** Uses the canonical connection and caller's creation/deletion transaction. */
export class PineconeProfileStore {
  constructor(private readonly client: Database.Database) {}

  get(agentId: string): PineconeProfileDto | undefined {
    const row = this.client.prepare(`SELECT p.agent_id, p.project_id, p.conversation_id,
      p.guidance_version, p.created_at FROM pinecone_profiles p
      JOIN agents a ON a.id=p.agent_id AND a.project_id=p.project_id AND a.conversation_id=p.conversation_id
      JOIN conversations c ON c.id=p.conversation_id AND c.project_id=p.project_id
      JOIN projects project ON project.id=p.project_id
      WHERE p.agent_id=? AND a.deleted_at IS NULL AND c.branch_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM branch_installation_resources r
          WHERE r.local_id IN (a.id,c.id) AND r.state!='active')`).get(agentId) as {
        agent_id: string; project_id: string; conversation_id: string;
        guidance_version: 1; created_at: string;
      } | undefined;
    return row ? { agentId: row.agent_id, projectId: row.project_id,
      conversationId: row.conversation_id, guidanceVersion: row.guidance_version,
      createdAt: row.created_at } : undefined;
  }

  insert(profile: PineconeProfileDto): void {
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
      (agent_id,project_id,conversation_id,guidance_version,created_at) VALUES (?,?,?,?,?)`)
      .run(profile.agentId, profile.projectId, profile.conversationId, profile.guidanceVersion, profile.createdAt);
  }
}
