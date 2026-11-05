import {describeBranchDeletionFailure} from './branch-deletion-diagnostics.js';
import {isMemoryCleanupHold} from './local-memory-authority.js';
import {issuedCaptureRetryBudget,generationHistoricalSelections} from '@ponderosa/agents';
import type {BranchPackageEngine} from './routes/agent-packages.js';
import type {ChatCreator} from "./routes/projects.js";
import {createHash} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {retainedResourceCapture,receiptMatchesSource,resourceCaptureFrontierHash,stableJson,type AgentStore,type BranchStore,type BranchResourceProvision } from '@ponderosa/agents';
import type { ImportAgentPackageResponse } from '@ponderosa/core';
export type BranchTemplateImporter = (input: BranchResourceProvision, hooks: {
  plan(agentIds: string[],creationOperationId?:string): void | Promise<void>; commit(result: ImportAgentPackageResponse): void;
  transaction?(operation:()=>void):void;
}, signal: AbortSignal) => Promise<void>;
const IMPORT_DEADLINE_MS = 5 * 60 * 1000;
/** Existing tracked template imports, driven only by the existing scheduler cycle. */
export class BranchResourceService {
  private importer?: BranchTemplateImporter;
  private packages?:BranchPackageEngine;
  private generationExitDrain?:(agentIds:string[])=>Promise<void>;
  setGenerationExitDrain(drain:(agentIds:string[])=>Promise<void>):void {this.generationExitDrain=drain;}
  async captureGenerationExitBeforeCleanup(stepId:string):Promise<void>{
    const generation=this.branches.resourceRetryGeneration(stepId);if(generation===undefined)return;
    const resource=this.store.sqlite.prepare('SELECT execution_id FROM branch_resources WHERE step_execution_id=?').get(stepId) as {execution_id:string};
    let journal=this.branches.generationExitCapture(resource.execution_id,stepId,generation);
    if(journal?.state==='sealed'){if(!this.packages)throw Error('Generation custody unavailable');await this.packages.readCheckpoint(journal.receipt);return;}
    journal=this.branches.fenceGenerationExit(stepId);
    this.branches.requireGenerationExitFence(resource.execution_id,stepId,generation);
    if(!this.generationExitDrain||!this.packages)throw Error('Observed generation runtime/custody service unavailable; cleanup held');
    this.branches.cancelResourceWork(stepId);
    await this.generationExitDrain(journal.identity.agentIds);
    journal=this.branches.reserveGenerationExit(resource.execution_id,stepId,generation);
    await this.packages.captureCheckpoint(journal.source,receipt=>this.branches.sealGenerationExit(resource.execution_id,stepId,generation,receipt));
    if(this.branches.generationExitCapture(resource.execution_id,stepId,generation)?.state!=='sealed')throw Error('Generation exit seal unavailable; cleanup held');
  }
  private finalPackageKey(stepId:string):string {return `final-resource-package:${stepId}:0`;}
  private requireFinalWorkingFolders(pkg:import('@ponderosa/core').AgentPortablePackageDto):void {
    if(!pkg||!Array.isArray(pkg.agents)||!pkg.agents.length)throw Error('Final resource package has no working-folder inventory');
    const roots=new Set(pkg.agents.filter(a=>a.workingFolder).map(a=>a.workingRootRef??a.ref));
    if(pkg.agents.some(a=>!a.workingRootRef||!roots.has(a.workingRootRef)))throw Error('Final resource working-folder inventory is incomplete; cleanup held');
  }

  /** Resume only the exact already-fenced automatic final package capture. */
  private async captureFinalPackage(executionId:string,stepId:string,create:boolean):Promise<void> {
    const key=this.finalPackageKey(stepId);
    let journal=this.branches.issuedResourceCapture(executionId,stepId,key);
    if(!create&&(!journal||journal.state!=='capturing'))return;
    if(!this.packages)throw Error('Final resource checkpoint package service unavailable; cleanup held');
    if(!journal)journal=this.branches.reserveFinalResourceCapture(executionId,stepId);
    this.branches.requireFinalResourceCaptureFence(executionId,stepId,key);
    if(journal.state==='retained'){this.requireFinalWorkingFolders(await this.packages.readCheckpoint(journal.receipt));this.branches.requireFinalResourceCaptureFence(executionId,stepId,key);return;}
    const status=await this.packages.inspectCheckpoint(journal.source);
    if(status.state!=='missing')throw Error(`Final resource package custody is ${status.state}; review the retained capture before cleanup`);
    await this.packages.captureCheckpoint(journal.source,receipt=>this.branches.sealIssuedResourceCapture(executionId,stepId,key,receipt),{wholeWorkingFolder:true});
    const retained=this.branches.issuedResourceCapture(executionId,stepId,key);
    if(retained?.state!=='retained')throw Error('Final resource package receipt unavailable; cleanup held');
    this.requireFinalWorkingFolders(await this.packages.readCheckpoint(retained.receipt));
    this.branches.requireFinalResourceCaptureFence(executionId,stepId,key);
  }
  /** Read the final receipt even after a previous cleanup pass deleted Agents. */
  private async verifyFinalPackage(executionId:string,stepId:string):Promise<void> {
    const marker=this.store.sqlite.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`final-package-intent:${stepId}:0`) as {input_hash:string;result_json:string}|undefined;
    if(!marker)return; // Older final exits did not have an automatic final package.
    const journal=this.branches.issuedResourceCapture(executionId,stepId,this.finalPackageKey(stepId)),exit=this.branches.requireFinalResourceExit(executionId,stepId);
    if(!journal||journal.state!=='retained'||!journal.receipt||exit.identity.generation!==0
      ||exit.selectedCheckpoint.id!==journal.checkpointId||exit.selectedCheckpoint.content_hash!==journal.checkpointHash)throw Error('Final resource package receipt unavailable; cleanup held');
    const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
    const saved=JSON.parse(marker.result_json);
    if(saved.schema!=='branch-final-package-intent.v2')throw Error('Final resource package predates working-folder capture; cleanup held');
    const intent={schema:'branch-final-package-intent.v2',wholeWorkingFolder:true,commandKey:this.finalPackageKey(stepId),sourceSha256:digest(journal.source),fenceSha256:exit.intakeFence.sha256};
    if(marker.input_hash!==digest(intent)||marker.result_json!==stableJson(intent))throw Error('Final resource package intent differs; cleanup held');
    if(!this.packages)throw Error('Final resource checkpoint package service unavailable; cleanup held');
    const retained=await this.packages.readCheckpoint(journal.receipt);this.requireFinalWorkingFolders(retained);
    if(stableJson(this.branches.requireFinalResourceExit(executionId,stepId))!==stableJson(exit))throw Error('Final resource exit changed during package verification');
    this.branches.requireFinalResourceFrontier(executionId,stepId);
  }
  private async captureFinalExitBeforeCleanup(stepId:string):Promise<void>{
    if(!this.branches.finalResourceExitRequired(stepId))return;
    const resource=this.store.sqlite.prepare('SELECT execution_id,state,generation FROM branch_resources WHERE step_execution_id=?').get(stepId) as {execution_id:string;state:string;generation:number};
    const retained=this.branches.retainedFinalResourceExit(stepId);
    if(retained){if(resource.state!=='retired'){await this.verifyFinalPackage(resource.execution_id,stepId);this.branches.requireFinalResourceFrontier(resource.execution_id,stepId);}return;}
    if(resource.state==='retired'){
      this.branches.requireFinalResourceExit(resource.execution_id,stepId);return;
    }
    const journal=this.branches.finalResourceExitFence(stepId);
    if(!this.generationExitDrain)throw Error('Observed final resource drain unavailable; cleanup held');
    this.branches.cancelResourceWork(stepId);
    await this.generationExitDrain(journal.identity.agentIds);
    if(!this.branches.resourceCanRetire(stepId,journal.identity.agentIds)||!this.idle(journal.identity.agentIds))throw Error('Final resource cleanup changed after drain');
    if(resource.generation===0)await this.captureFinalPackage(resource.execution_id,stepId,true);
    if(!this.branches.resourceCanRetire(stepId,journal.identity.agentIds)||!this.idle(journal.identity.agentIds))throw Error('Final resource cleanup changed after package capture');
    this.branches.captureFinalResourceExit(journal);
  }
  setPackageEngine(engine:BranchPackageEngine):void {this.packages=engine;}
  destinationPackageEngine():BranchPackageEngine {if(!this.packages)throw Error('Checkpoint package service unavailable');return this.packages;}
  private pending?: Promise<void>;
  private maintenance?:Promise<void>;
  private importController?: AbortController;
  private stopped = false;
  constructor(private readonly branches: BranchStore, private readonly store: AgentStore,
    private readonly deleteAgents: (agentIds: string[]) => Promise<void>, private readonly createChat: ChatCreator,
    private readonly deleteChat: (chatId: string) => Promise<void>) {}
  get custodyLifecycle(){return this.branches.custodyLifecycle;}
  setImporter(importer: BranchTemplateImporter): void { this.importer = importer; }
  async tick(admit: boolean): Promise<void> {
    if (this.pending) {await this.maintain();return this.pending;}
    const operation = this.work(admit && !this.stopped); this.pending = operation;
    try { await operation; } finally { if (this.pending === operation) this.pending = undefined; }
  }
  async verifyHistoricalCustody(executionId:string,checkpointId:number,expectedHash:string):Promise<void> {
    const row=this.store.sqlite.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,checkpointId) as {snapshot_json:string;content_hash:string}|undefined;
    if(!row||row.content_hash!==expectedHash||createHash('sha256').update(row.snapshot_json).digest('hex')!==expectedHash)throw Error('Historical resource checkpoint unavailable');
    const snapshot=JSON.parse(row.snapshot_json);
    if(stableJson(snapshot)!==row.snapshot_json)throw Error('Historical resource checkpoint is not canonical');
    const digest=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
    if(snapshot.captureKind==='issued_resource'){
      // The pre-opening resource capture in selected.resources belongs to an
      // earlier frontier and cannot stand in for this issued package.
      const receipt=snapshot.issuedResourceCustody as import('@ponderosa/core').CheckpointPackageReceipt|undefined;
      const selected=snapshot.selected,resource=selected?.resources?.[0],host=snapshot.hostDependencies;
      if(!receipt||!selected||!host||selected.execution?.[0]?.id!==executionId
        ||selected.resources?.length!==1||!resource||!host.coverage?.complete
        ||receipt.intent.executionId!==executionId||receipt.intent.resourceStepId!==resource.step_execution_id
        ||receipt.intent.resourceGeneration!==resource.generation||receipt.sourceChatId!==resource.chat_id
        ||receipt.intent.hostCutSha256!==digest(host)||receipt.intent.frontierSha256!==resourceCaptureFrontierHash(selected)
        ||receipt.intent.bindingSha256!==host.bindingPin?.sha256)throw Error('Issued custody does not bind the exact retained host graph');
      const {version,custodyId,boundaryId,sha256,byteLength,...source}=receipt;
      if(!receiptMatchesSource(receipt,source))throw Error('Issued custody receipt integrity failure');
      if(!this.packages)throw Error('Checkpoint package service unavailable');
      await this.packages.readCheckpoint(receipt);
    }else{
      if(snapshot.issuedResourceCustody)throw Error('Issued custody requires an issued checkpoint');
      for(const owner of snapshot.continuation?.owners??[{selected:snapshot.selected}]){
        const capture=retainedResourceCapture(owner.selected);
        if(capture){if(!this.packages)throw Error('Checkpoint package service unavailable');await this.packages.readCheckpoint(capture.receipt!);}
      }
    }
    const current=this.store.sqlite.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,checkpointId) as typeof row;
    if(!current||current.snapshot_json!==row.snapshot_json||current.content_hash!==row.content_hash)throw Error('Historical resource checkpoint changed during custody verification');
  }
  listGenerationOneCaptures(executionId:string,stepId:string):import('@ponderosa/core').BranchIssuedResourceCaptureDto[] {return this.listGenerationHistoryCaptures(executionId,stepId,1);}
  listGenerationHistoryCaptures(executionId:string,stepId:string,generation?:number):import('@ponderosa/core').BranchIssuedResourceCaptureDto[] {
    const rows=this.store.sqlite.prepare(`SELECT command_key FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-resource-capture:%'
      AND json_extract(result_json,'$.source.intent.resourceStepId')=? AND json_extract(result_json,'$.source.intent.resourceGeneration')>0 AND (? IS NULL OR json_extract(result_json,'$.source.intent.resourceGeneration')=?) ORDER BY command_key LIMIT 101`).all(executionId,stepId,generation??null,generation??null) as {command_key:string}[];
    if(rows.length>100)throw Error('Generation-history discovery exceeds bounded inventory');
    return rows.map(row=>this.issuedResourceCaptureStatus(executionId,stepId,row.command_key.slice('issued-resource-capture:'.length)));
  }
  issuedResourceCaptureStatus(executionId:string,stepId:string,commandKey:string):import('@ponderosa/core').BranchIssuedResourceCaptureDto {
    const journal=this.branches.issuedResourceCapture(executionId,stepId,commandKey);
    const retry=journal?.snapshot.issuedContinuation?.generationRetry,selection=retry?generationHistoricalSelections(retry):undefined;
    const retryBudget=journal?issuedCaptureRetryBudget(this.store.sqlite,executionId,journal):undefined;
    return journal?{...(retryBudget?.state==='verified'?{historyKind:journal.snapshot.selected.forks.length?'local_parallel' as const:'serial' as const}:{}),retryBudget,...(retryBudget?.state==='verified'?{consumedAttempts:retryBudget.consumedAttempts,maxAttempts:retryBudget.maxAttempts}:{}),commandKey,generation:journal.source.intent.resourceGeneration,state:journal.state,...(journal.reviewHash?{reviewHash:journal.reviewHash}:{}),...(selection?{historicalPartition:selection,historicalReviewHash:createHash('sha256').update(stableJson(selection)).digest('hex')}:{}),...(journal.state==='retained'?{checkpointId:journal.checkpointId,checkpointHash:journal.checkpointHash,receipt:journal.receipt}:{}),restoreSupported:false}:{commandKey,state:'not_found',restoreSupported:false};
  }
  async captureIssuedResource(executionId:string,stepId:string,generation:number,commandKey:string,expectedReviewHash?:string):Promise<import('@ponderosa/core').BranchIssuedResourceCaptureDto> {
    if(commandKey.startsWith('final-resource-package:'))throw Error('This capture key is reserved for final resource cleanup');
    const previous=this.branches.issuedResourceCapture(executionId,stepId,commandKey);
    if(previous&&generation>0&&expectedReviewHash!==previous.reviewHash)throw Error('Issued capture preview conflict');
    if(previous&&previous.source.intent.resourceGeneration!==generation)throw Error('Issued capture command conflict');
    if(previous?.state==='retained')return this.issuedResourceCaptureStatus(executionId,stepId,commandKey);
    if(!this.packages)throw Error('Checkpoint package service unavailable');
    const journal=this.branches.reserveIssuedResourceCapture(executionId,stepId,generation,commandKey,expectedReviewHash);
    // A retained payload without the committed Branch seal is ambiguous. Never
    // reconstruct an earlier host frontier from current mutable source data.
    await this.packages.captureCheckpoint(journal.source,receipt=>this.branches.sealIssuedResourceCapture(executionId,stepId,commandKey,receipt));
    const sealed=this.branches.issuedResourceCapture(executionId,stepId,commandKey);
    if(sealed?.state!=='retained')throw Error('Issued resource capture did not commit its Branch seal');
    return this.issuedResourceCaptureStatus(executionId,stepId,commandKey);
  }
  async inspectResource(stepExecutionId:string):Promise<import('@ponderosa/core').BranchResourceInspectionDto> {
    const snapshot=this.branches.resourceInspection(stepExecutionId),journal=this.branches.resourceRestoreJournal(stepExecutionId);
    if(!journal||!snapshot.destinationChatId||!snapshot.destinationChatAvailable||snapshot.state!=='reserved'||snapshot.importState)return snapshot;
    let review:import('@ponderosa/core').AgentAccessImportReviewDto|null=null,reviewError:string|undefined;
    try{
      if(!this.packages)throw Error('Checkpoint package service unavailable');
      const portable=await this.packages.readCheckpoint(journal.receipt);
      review=await this.packages.reviewAccess({...portable,rootRef:journal.rootRef},snapshot.destinationChatId);
    }catch(error){reviewError=error instanceof Error?error.message:'Resource policy review unavailable';}
    if(stableJson(this.branches.resourceInspection(stepExecutionId))!==stableJson(snapshot)||stableJson(this.branches.resourceRestoreJournal(stepExecutionId))!==stableJson(journal))throw Error('Resource inspection changed; refresh');
    return {...snapshot,currentPolicyReview:review,accessChoiceCurrent:!!review&&journal.choice?.reviewSha256===review.reviewSha256,...(reviewError?{reviewError}:{})};
  }
  async reviewRestoreAccess(stepExecutionId:string,choice?:import('@ponderosa/core').ImportAgentPackageRequest['accessSettingsResolution']) {
    if(!this.packages)throw Error('Checkpoint package service unavailable');
    const snapshot=this.branches.resourceInspection(stepExecutionId),journal=this.branches.resourceRestoreJournal(stepExecutionId);
    const row=this.store.sqlite.prepare('SELECT r.chat_id,r.execution_id,e.branch_id FROM branch_resources r JOIN branch_executions e ON e.id=r.execution_id WHERE r.step_execution_id=?').get(stepExecutionId) as {chat_id:string;execution_id:string;branch_id:string}|undefined;
    if(!journal||!row?.chat_id)throw Error('Fresh resource destination Chat is not ready');
    const portable=await this.packages.readCheckpoint(journal.receipt),review=await this.packages.reviewAccess({...portable,rootRef:journal.rootRef},row.chat_id);
    if(stableJson(this.branches.resourceInspection(stepExecutionId))!==stableJson(snapshot)||stableJson(this.branches.resourceRestoreJournal(stepExecutionId))!==stableJson(journal))throw Error('Resource destination changed; review again');
    this.branches.resourceRestoreReview(stepExecutionId,review,choice);return review;
  }
  async releaseCapture(stepExecutionId:string,input:import('@ponderosa/core').BranchResourceCustodyReleaseInput):Promise<import('@ponderosa/core').BranchResourceCustodyReleaseDto> {
    if(!this.packages)throw Error('Checkpoint package service unavailable');
    const command=this.branches.beginResourceCustodyRelease(stepExecutionId,input);
    if(command.result.state==='released')return command.result;
    try{await this.packages.releaseCheckpoint(command.receipt);}
    catch(error){return this.branches.finishResourceCustodyRelease(stepExecutionId,input.commandKey,error instanceof Error?error.message:'Checkpoint custody release outcome unknown');}
    return this.branches.finishResourceCustodyRelease(stepExecutionId,input.commandKey);
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
        if(imported?.state==='completed'){
          if(!this.branches.resourceCaptureEligible(provision.stepExecutionId)&&!this.branches.resourceCaptureJournal(provision.stepExecutionId)){this.branches.bindResource(provision.stepExecutionId,imported.result as ImportAgentPackageResponse);continue;}
          if(!this.packages)throw Error('Checkpoint package service unavailable');
          const source=this.branches.reserveResourceCapture(provision.stepExecutionId);
          const observed=await this.packages.inspectCheckpoint(source);
          const receipt=observed.state==='retained'?observed.receipt:observed.state==='missing'?await this.packages.captureCheckpoint(source):undefined;
          if(!receipt)throw Error(`Resource capture ${observed.state}; explicit owner reconciliation required`);
          this.branches.finishResourceCapture(source,receipt);
          await this.branches.waitResourceCheckpoint(provision.stepExecutionId);
          this.branches.bindResource(provision.stepExecutionId,imported.result as ImportAgentPackageResponse);continue;
        }
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
        const restore=this.branches.resourceRestoreJournal(provision.stepExecutionId);
        let accessSettingsResolution:import('@ponderosa/core').ImportAgentPackageRequest['accessSettingsResolution'];
        if(restore){
          if(!this.packages)throw Error('Checkpoint package service unavailable');
          const portable=await this.packages.readCheckpoint(restore.receipt);
          if(!portable.agents.some(node=>node.ref===restore.rootRef)||portable.agents.length!==provision.template.agents.length)throw Error('Retained resource Agent inventory differs');
          provision={...provision,template:{...portable,rootRef:restore.rootRef}};
          this.packages.validateAgent(provision.template,provision.engineMapping);
          const review=await this.packages.reviewAccess(provision.template,provision.chatId);
          if(!restore.choice||restore.choice.reviewSha256!==review.reviewSha256){
            this.branches.resourceRestoreReview(provision.stepExecutionId,review);continue;
          }
          accessSettingsResolution=restore.choice;
        }
        // Every new effect revalidates current owner/ancestor release after the previous await.
        phase='import';token=this.branches.beginResourceOperation(provision.stepExecutionId,provision.creationKey,phase);if(!token)continue;
        const importToken=token;
        await this.importer({...provision,...(accessSettingsResolution?{accessSettingsResolution}:{})}, {
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
        else if(this.branches.resourceCaptureJournal(provision.stepExecutionId))this.branches.resourceCaptureError(provision.stepExecutionId,message);
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
      const held=this.store.sqlite.prepare('SELECT r.error,(SELECT error FROM branch_retirement_errors WHERE resource_id=r.chat_id) retirement_error FROM branch_resources r WHERE r.step_execution_id=?').get(resource.stepExecutionId) as {error:string|null;retirement_error:string|null}|undefined;
      if(isMemoryCleanupHold(held?.error)||isMemoryCleanupHold(held?.retirement_error))continue;
      try {
        const capture=this.branches.resourceCaptureJournal(resource.stepExecutionId);
        await this.captureFinalPackage(resource.executionId,resource.stepExecutionId,false);
        if(capture?.state==='capturing'&&!this.branches.resourceCaptureAbandoned(resource.stepExecutionId)||this.branches.issuedResourceCapturePending(resource.stepExecutionId))continue;
        if(capture?.state==='retained'){if(!this.packages||!capture.receipt)throw Error('Required checkpoint custody unavailable');await this.packages.readCheckpoint(capture.receipt);}
        this.branches.cancelResourceWork(resource.stepExecutionId);
        await this.captureGenerationExitBeforeCleanup(resource.stepExecutionId);
        await this.captureFinalExitBeforeCleanup(resource.stepExecutionId);
        if (!this.branches.resourceCanRetire(resource.stepExecutionId,resource.agentIds) || !this.idle(resource.agentIds)) continue;
        await this.deleteAgents(resource.agentIds);
        if(this.branches.finalResourceExitRequired(resource.stepExecutionId)){await this.verifyFinalPackage(resource.executionId,resource.stepExecutionId);this.branches.requireFinalResourceFrontier(resource.executionId,resource.stepExecutionId);}
        if (!this.branches.resourceCanRetire(resource.stepExecutionId,resource.agentIds) || !this.idle(resource.agentIds)) continue;
        for (const id of resource.agentIds) {
          if (this.store.sqlite.prepare('SELECT 1 FROM provider_process_authority WHERE agent_id=?').get(id)) throw new Error('Provider process cleanup remains pending');
        }
        if (resource.chatId) {
          const chat = this.store.getConversation(resource.chatId);
          if (chat && (chat.branchId !== resource.branchId || chat.executionId !== resource.executionId)) throw new Error('Temporary Chat ownership changed');
          await this.deleteChat(resource.chatId);
          if(this.branches.finalResourceExitRequired(resource.stepExecutionId))this.branches.requireFinalResourceFrontier(resource.executionId,resource.stepExecutionId);
          if (!this.branches.resourceCanRetire(resource.stepExecutionId,resource.agentIds)) continue;
        }
        // The shared deletion authority has observed process and private-state cleanup.
        // The final SQLite check still rejects new members or an obsolete generation.
        this.branches.resourceRetired(resource.stepExecutionId);
      } catch(error) { this.branches.resourceCleanupError(resource.stepExecutionId,error instanceof Error ? error.message : 'Resource cleanup remains pending'); }
    }
    for (const context of this.branches.resourceContextCleanupCandidates()) {
      const held=this.store.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(context.chatId) as {error:string}|undefined;
      if(isMemoryCleanupHold(held?.error))continue;
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
          .run(context.chatId,describeBranchDeletionFailure(error,'historical'),new Date().toISOString());
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
