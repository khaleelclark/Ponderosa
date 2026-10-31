import type {ChatCreator} from "./routes/projects.js";
import {createHash} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import type { AgentStore, BranchStore, BranchResourceProvision } from '@ponderosa/agents';
import type { ImportAgentPackageResponse } from '@ponderosa/core';
export type BranchTemplateImporter = (input: BranchResourceProvision, hooks: {
  plan(agentIds: string[],creationOperationId?:string): void | Promise<void>; commit(result: ImportAgentPackageResponse): void;
  transaction?(operation:()=>void):void;
}, signal: AbortSignal) => Promise<void>;
const IMPORT_DEADLINE_MS = 5 * 60 * 1000;
/** Existing tracked template imports, driven only by the existing scheduler cycle. */
export class BranchResourceService {
  private importer?: BranchTemplateImporter;
  private pending?: Promise<void>;
  private maintenance?:Promise<void>;
  private importController?: AbortController;
  private stopped = false;
  constructor(private readonly branches: BranchStore, private readonly store: AgentStore,
    private readonly deleteAgents: (agentIds: string[]) => Promise<void>, private readonly createChat: ChatCreator,
    private readonly deleteChat: (chatId: string) => Promise<void>) {}
  setImporter(importer: BranchTemplateImporter): void { this.importer = importer; }
  async tick(admit: boolean): Promise<void> {
    if (this.pending) {await this.maintain();return this.pending;}
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
      const controller = new AbortController();
      this.importController = controller;
      const timer = setTimeout(() => controller.abort(new Error('Temporary Agent import exceeded its deadline')), IMPORT_DEADLINE_MS);
      let phase:'chat'|'import'|undefined,token:string|undefined;
      try {
        const imported=this.branches.resourceOperation(provision.stepExecutionId,'import');
        if(imported?.state==='completed'){this.branches.bindResource(provision.stepExecutionId,imported.result as ImportAgentPackageResponse);continue;}
        if(!provision.chatId){
          const configuredDirectory=provision.workingDirectory?.trim();
          let hostPath:string|undefined;
          if(configuredDirectory)try{
            hostPath=realpathSync(resolve(configuredDirectory));
            if(!statSync(hostPath).isDirectory())throw new Error('not a directory');
          }catch{
            throw Object.assign(new Error('Temporary Agent working directory is unavailable or is not a directory'),{provisionRejected:true});
          }
          if(!provision.defaultEngine)throw Object.assign(new Error('Choose an Engine for the temporary Agent template'),{provisionRejected:true});
          phase='chat';token=this.branches.beginResourceOperation(provision.stepExecutionId,provision.creationKey,phase);if(!token)continue;
          await this.branches.waitResourceCheckpoint(provision.stepExecutionId);
          controller.signal.throwIfAborted();
          if(!this.branches.releaseResourceChat(provision.stepExecutionId,provision.creationKey,token)){
            this.branches.finishResourceOperation(provision.stepExecutionId,phase,token,new Error('Chat release held by current authority or checkpoint coverage'));
            token=undefined;phase=undefined;continue;
          }
          const chat=await this.createChat({label:'Temporary workflow organization',hostPath,defaultEngine:provision.defaultEngine},
            'branch-resource-'+createHash('sha256').update(provision.creationKey).digest('hex'),{branchId:provision.branchId,executionId:provision.executionId},controller.signal);
          this.branches.completeResourceOperation(provision.stepExecutionId,phase,token,{chatId:chat.id});
          token=undefined;phase=undefined;
          provision={...provision,projectId:chat.projectId,chatId:chat.id};
        }
        if (this.stopped) break;
        controller.signal.throwIfAborted();
        // Every new effect revalidates current owner/ancestor release after the previous await.
        phase='import';token=this.branches.beginResourceOperation(provision.stepExecutionId,provision.creationKey,phase);if(!token)continue;
        const importToken=token;
        await this.importer(provision, {
          plan: async(ids,creationOperationId) => {
            this.branches.observeResourceImportPlan(provision.stepExecutionId,importToken,creationOperationId);
            // The start/receipt markers must be covered before a later plan/effect boundary.
            await this.branches.waitResourceCheckpoint(provision.stepExecutionId);controller.signal.throwIfAborted();
            this.branches.planResource(provision.stepExecutionId,ids,importToken);
          },
          commit: result => this.branches.completeResourceOperation(provision.stepExecutionId,'import',importToken,result),
          transaction: operation=>this.branches.unitTransaction(operation)(),
        }, controller.signal);
        this.branches.finishResourceOperation(provision.stepExecutionId,phase,importToken);
        token=undefined;phase=undefined;
      } catch (error) {
        const message=error instanceof Error ? error.message : 'Template creation failed';
        if(phase&&token)this.branches.finishResourceOperation(provision.stepExecutionId,phase,token,error);
        else this.branches.resourceError(provision.stepExecutionId,message);
        if (error && typeof error === 'object' && 'provisionRejected' in error && error.provisionRejected) this.branches.resourceRejected(provision.stepExecutionId,message);
      } finally {
        clearTimeout(timer);
        if (this.importController === controller) this.importController = undefined;
      }
    }
    await this.maintain();
  }
  private async maintain():Promise<void> {
    if(this.maintenance)return this.maintenance;
    const operation=this.cleanup();this.maintenance=operation;
    try{await operation;}finally{if(this.maintenance===operation)this.maintenance=undefined;}
  }
  private async cleanup():Promise<void> {
    for (const resource of this.branches.resourceCleanupCandidates()) {
      try {
        this.branches.cancelResourceWork(resource.stepExecutionId);
        if (!this.branches.resourceCanRetire(resource.stepExecutionId,resource.agentIds) || !this.idle(resource.agentIds)) continue;
        await this.deleteAgents(resource.agentIds);
        if (!this.branches.resourceCanRetire(resource.stepExecutionId,resource.agentIds) || !this.idle(resource.agentIds)) continue;
        for (const id of resource.agentIds) {
          if (this.store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE agent_id=?').get(id)) throw new Error('Provider process cleanup remains pending');
        }
        if (resource.chatId) {
          const chat = this.store.getConversation(resource.chatId);
          if (chat && (chat.branchId !== resource.branchId || chat.executionId !== resource.executionId)) throw new Error('Temporary Chat ownership changed');
          await this.deleteChat(resource.chatId);
          if (!this.branches.resourceCanRetire(resource.stepExecutionId,resource.agentIds)) continue;
        }
        // The shared deletion authority has observed process and private-state cleanup.
        // The final SQLite check still rejects new members or an obsolete generation.
        this.branches.resourceRetired(resource.stepExecutionId);
      } catch(error) { this.branches.resourceError(resource.stepExecutionId,error instanceof Error ? error.message : 'Resource cleanup remains pending'); }
    }
    for (const context of this.branches.resourceContextCleanupCandidates()) {
      try {
        const chat=this.store.getConversation(context.chatId,{includeDeleting:true});
        if(chat && (chat.branchId!==context.branchId || chat.executionId!==context.executionId)) throw new Error('Historical temporary Chat ownership changed');
        // Historical generations already drained their Agents before the old
        // pointer reset. Never delete a still-live organization as catch-up.
        if(!this.idle(context.agentIds) || context.agentIds.some(id=>this.store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE agent_id=?').get(id))
          || this.store.sqlite.prepare('SELECT 1 FROM agents WHERE conversation_id=? AND deleted_at IS NULL').get(context.chatId)) continue;
        await this.deleteChat(context.chatId);
        this.store.sqlite.prepare('DELETE FROM branch_retirement_errors WHERE resource_id=?').run(context.chatId);
      } catch(error) {
        this.store.sqlite.prepare('INSERT INTO branch_retirement_errors VALUES(?,?,?) ON CONFLICT(resource_id) DO UPDATE SET error=excluded.error,updated_at=excluded.updated_at')
          .run(context.chatId,error instanceof Error?error.message:'Historical Chat cleanup remains pending',new Date().toISOString());
      }
    }
  }
  errors():Error[]{return this.branches.resourceErrors();}
  activeOperationCount():number{return Number(Boolean(this.pending))+Number(Boolean(this.maintenance));}
  requestStop(): void {
    this.stopped=true;
    this.importController?.abort(new Error('Branch workflow shutdown interrupted temporary Agent import'));
  }
  async stop(): Promise<void> { this.requestStop();await this.pending;await this.maintenance; }
}
