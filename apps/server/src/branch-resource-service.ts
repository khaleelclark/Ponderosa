import {createHash} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import type { AgentStore, BranchStore, BranchResourceProvision } from '@ponderosa/agents';
import type { ImportAgentPackageResponse } from '@ponderosa/core';
export type BranchTemplateImporter = (input: BranchResourceProvision, hooks: {
  plan(agentIds: string[]): void; commit(result: ImportAgentPackageResponse): void;
}) => Promise<void>;
/** Existing tracked template imports, driven only by the existing scheduler cycle. */
export class BranchResourceService {
  private importer?: BranchTemplateImporter;
  private pending?: Promise<void>;
  private stopped = false;
  constructor(private readonly branches: BranchStore, private readonly store: AgentStore,
    private readonly drain: (agentIds: string[]) => Promise<void>) {}
  setImporter(importer: BranchTemplateImporter): void { this.importer = importer; }
  async tick(admit: boolean): Promise<void> {
    if (this.pending) return this.pending;
    const operation = this.work(admit && !this.stopped); this.pending = operation;
    try { await operation; } finally { if (this.pending === operation) this.pending = undefined; }
  }
  private idle(agentIds: string[]): boolean {
    return agentIds.every(id => !this.store.sqlite.prepare(`SELECT 1 FROM agent_creation_operation_members m JOIN agent_creation_operations o ON o.id=m.operation_id WHERE m.agent_id=? AND o.status NOT IN ('completed','rolled_back')`).get(id)
      && !this.store.sqlite.prepare('SELECT 1 FROM agent_deletion_pending WHERE agent_id=?').get(id)
      // Historical tombstones remain as audit/custody evidence after deletion.
      // Only an unfinished storage-cleanup receipt still fences resource drain.
      && !this.store.sqlite.prepare(`SELECT 1 FROM agent_deletion_receipts receipt
        JOIN json_each(receipt.deleted_agent_ids_json) member ON member.value=?
        WHERE receipt.storage_cleanup_completed=0 LIMIT 1`).get(id)
      && !this.store.sqlite.prepare(`SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')`).get(id)
      && !this.store.sqlite.prepare(`SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending')`).get(id)
      && !this.store.sqlite.prepare(`SELECT 1 FROM coordination_requests WHERE recipient_agent_id=? AND state NOT IN ('completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded','outcome_unknown')`).get(id));
  }
  private async work(admit: boolean): Promise<void> {
    if (admit && this.importer) for (let provision of this.branches.resourceProvisions().slice(0, 1)) {
      try {
        if(!provision.chatId){
          const configuredDirectory=provision.workingDirectory?.trim();
          let hostPath:string|undefined;
          if(configuredDirectory)try{
            hostPath=realpathSync(resolve(configuredDirectory));
            if(!statSync(hostPath).isDirectory())throw new Error('not a directory');
          }catch{
            throw Object.assign(new Error('Temporary Agent working directory is unavailable or is not a directory'),{provisionRejected:true});
          }
          const payload={label:'Temporary workflow organization',chatOwned:true,branchId:provision.branchId,executionId:provision.executionId,hostPath,defaultEngine:provision.defaultEngine};
          if(!payload.defaultEngine)throw Object.assign(new Error('Choose an Engine for the temporary Agent template'),{provisionRejected:true});
          const project=this.store.createProject(payload,{idempotencyKey:provision.creationKey,payloadHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')});
          if(!project.lastConversationId)throw new Error('Temporary Chat creation did not establish its context');
          this.branches.bindResourceChat(provision.stepExecutionId,project.lastConversationId);
          provision={...provision,projectId:project.id,chatId:project.lastConversationId};
        }
        await this.importer(provision, {
          plan: ids => this.store.sqlite.transaction(()=>this.branches.planResource(provision.stepExecutionId,ids))(),
          commit: result => this.branches.bindResource(provision.stepExecutionId,result),
        });
      } catch (error) {
        const message=error instanceof Error ? error.message : 'Template creation failed';
        this.branches.resourceError(provision.stepExecutionId,message);
        if (error && typeof error === 'object' && 'provisionRejected' in error && error.provisionRejected) this.branches.resourceRejected(provision.stepExecutionId,message);
      }
    }
    for (const resource of this.branches.resourceCleanupCandidates()) {
      try {
        this.branches.cancelResourceWork(resource.stepExecutionId);
        if (!this.branches.resourceCanArchive(resource.stepExecutionId,resource.agentIds) || !this.idle(resource.agentIds)) continue;
        await this.drain(resource.agentIds);
        if (!this.branches.resourceCanArchive(resource.stepExecutionId,resource.agentIds) || !this.idle(resource.agentIds)) continue;
        for (const id of resource.agentIds) {
          if (this.store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE agent_id=?').get(id)) throw new Error('Provider process cleanup remains pending');
        }
        // No await between the final authority check, archival, and the workflow checkpoint.
        // Archival has its own durable filesystem/SQLite boundary. Resume partial archival rather than rolling it back.
        for (const id of resource.agentIds) if (this.store.getAgent(id)) this.store.updateAgent(id,{archived:true});
        this.branches.resourceArchived(resource.stepExecutionId);
      } catch(error) { this.branches.resourceError(resource.stepExecutionId,error instanceof Error ? error.message : 'Resource cleanup remains pending'); }
    }
  }
  async stop(): Promise<void> { this.stopped=true;await this.pending; }
}
