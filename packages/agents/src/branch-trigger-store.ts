import type {BranchUnitTransaction} from "./branch-unit-saver.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TriggerDefinitionDto, TriggerOccurrenceDto, TriggerSourceConfig } from "@ponderosa/core";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import type { BranchTriggerIntake, CreateTriggerDefinitionInput, UpdateTriggerDefinitionInput,
  RecordTriggerOccurrenceInput, TriggerOccurrenceResult, TriggerFilesystemBurst } from "./branch-trigger-types.js";

const TRIGGER_CANONICAL_JSON_LIMITS = {maxDepth:64,maxNodes:250_000} as const;

type Row = Record<string, any>;

/** Branch-only event intake on the canonical SQLite connection. An occurrence
 * and its workflow execution commit together. Only the scheduler creates Runs. */
export class BranchTriggerStore {
  constructor(readonly sqlite: Database.Database, private readonly accept: (input: BranchTriggerIntake) => string,
    private readonly cancelUndeliveredUpdate?: (occurrenceId:string,now:string)=>boolean,
    private readonly transaction:BranchUnitTransaction = operation=>sqlite.transaction(operation)) {}

  private requireBranch(branchId: string): void {
    if (!branchId || !this.sqlite.prepare("SELECT 1 FROM branches WHERE id=? AND deleting=0").get(branchId)) {
      throw new Error("Branch destination is unavailable");
    }
  }

  private row(id: string): Row | undefined {
    return this.sqlite.prepare("SELECT id,project_id,conversation_id,branch_id,name,instructions,source_kind,source_config_json,enabled,next_fire_at,last_fired_at,created_at,updated_at FROM trigger_definitions WHERE id=?").get(id) as Row | undefined;
  }

  private text(name: string, instructions: string): void {
    if (!name.trim() || name.trim().length > 120) throw new Error("Automation name must be between 1 and 120 characters");
    if (!instructions.trim() || instructions.trim().length > 20_000) throw new Error("Automation instructions must be between 1 and 20000 characters");
  }

  createTriggerDefinition(input: CreateTriggerDefinitionInput): TriggerDefinitionDto {
    this.text(input.name, input.instructions);
    if (input.targetAgentId !== undefined || input.runBudget !== undefined) throw new Error("Branch triggers cannot target Agents or grant provider Run budgets");
    const now = input.now ?? new Date().toISOString(), id = input.id ?? randomUUID();
    return this.transaction(() => {
      this.requireBranch(input.branchId);
      this.sqlite.prepare(`INSERT INTO trigger_definitions
        (id,project_id,conversation_id,branch_id,name,instructions,source_kind,source_config_json,enabled,next_fire_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.projectId,input.conversationId,input.branchId,input.name.trim(),input.instructions.trim(),
          input.sourceKind,stableJson(input.sourceConfig),input.enabled === false ? 0 : 1,input.nextFireAt ?? null,now,now);
      return this.getTriggerDefinition(id)!;
    })();
  }

  getTriggerDefinition(id: string): TriggerDefinitionDto | undefined {
    const row = this.row(id);
    return row && { id:row.id,projectId:row.project_id,conversationId:row.conversation_id,branchId:row.branch_id,
      name:row.name,instructions:row.instructions,sourceKind:row.source_kind,sourceConfig:JSON.parse(row.source_config_json) as TriggerSourceConfig,
      enabled:Boolean(row.enabled),fullAccess:true,createdAt:row.created_at,updatedAt:row.updated_at,
      ...(row.next_fire_at ? {nextFireAt:row.next_fire_at} : {}),...(row.last_fired_at ? {lastFiredAt:row.last_fired_at} : {}),
      ...(row.source_kind === "webhook" ? {webhookPath:`/api/trigger-webhooks/${row.id}`} : {}) };
  }

  updateTriggerDefinition(id: string, input: UpdateTriggerDefinitionInput): TriggerDefinitionDto | undefined {
    if (input.targetAgentId !== undefined || input.runBudget !== undefined) throw new Error("Branch triggers cannot target Agents or grant provider Run budgets");
    const now = input.now ?? new Date().toISOString();
    return this.transaction(() => {
      const row = this.row(id); if (!row) return undefined;
      if (input.branchId !== undefined && input.branchId !== row.branch_id) throw new Error("Branch trigger destination is immutable");
      // Disabling must remain possible while the Branch itself is deleting.
      if (input.enabled !== false) this.requireBranch(row.branch_id);
      const name = input.name?.trim() ?? row.name, instructions = input.instructions?.trim() ?? row.instructions;
      this.text(name,instructions);
      this.sqlite.prepare(`UPDATE trigger_definitions SET conversation_id=?,name=?,instructions=?,source_config_json=?,enabled=?,next_fire_at=?,
        updated_at=? WHERE id=?`).run(input.conversationId ?? row.conversation_id,name,instructions,
          input.sourceConfig === undefined ? row.source_config_json : stableJson(input.sourceConfig),input.enabled === undefined ? row.enabled : Number(input.enabled),
          input.nextFireAt === undefined ? row.next_fire_at : input.nextFireAt,now,id);
      if (input.enabled === false) this.cancelPending(id,"Automation disabled",now);
      return this.getTriggerDefinition(id);
    })();
  }

  private cancelPending(id: string, reason: string, now: string): void {
    this.sqlite.prepare("DELETE FROM trigger_filesystem_bursts WHERE trigger_id=?").run(id);
    for(const row of this.sqlite.prepare("SELECT id,activation_id FROM trigger_occurrences WHERE trigger_id=? AND state='pending'").all(id) as Row[]){
      // An already submitted update is accepted work, not new source intake.
      // Retain its unresolved evidence rather than pretending disable undid it.
      if(row.activation_id&&!this.cancelUndeliveredUpdate?.(row.id,now))continue;
      this.sqlite.prepare("UPDATE trigger_occurrences SET state='cancelled',last_error=?,cancelled_at=?,updated_at=? WHERE id=? AND state='pending'").run(reason,now,now,row.id);
    }
  }

  deleteTriggerDefinition(id: string, now = new Date().toISOString()): boolean {
    return this.transaction(() => {
      this.cancelPending(id,"Automation deleted",now);
      return this.sqlite.prepare("DELETE FROM trigger_definitions WHERE id=?").run(id).changes === 1;
    })();
  }

  listDueScheduleTriggers(now = new Date().toISOString(), limit = 100, after?: { nextFireAt: string; id: string }): TriggerDefinitionDto[] {
    const rows = this.sqlite.prepare(`SELECT t.id FROM trigger_definitions t JOIN branches b ON b.id=t.branch_id
      WHERE t.enabled=1 AND b.enabled=1 AND b.deleting=0 AND b.trigger_id=t.id
        AND t.source_kind='schedule' AND t.next_fire_at<=?
        AND (? IS NULL OR t.next_fire_at>? OR (t.next_fire_at=? AND t.id>?))
        ORDER BY t.next_fire_at,t.id LIMIT ?`)
      .all(now, after?.nextFireAt ?? null, after?.nextFireAt ?? null, after?.nextFireAt ?? null, after?.id ?? null, Math.max(1,Math.min(500,limit))) as {id:string}[];
    return rows.map(row => this.getTriggerDefinition(row.id)!);
  }

  listTriggerDefinitions(beforeId?:string,limit=100,branchId?:string):TriggerDefinitionDto[]{
    return (this.sqlite.prepare(`SELECT id FROM trigger_definitions WHERE (? IS NULL OR id>?)
      AND (? IS NULL OR branch_id=?) ORDER BY id LIMIT ?`).all(beforeId??null,beforeId??null,branchId??null,branchId??null,Math.max(1,Math.min(500,limit))) as {id:string}[])
      .map(row=>this.getTriggerDefinition(row.id)!);
  }

  private filesystemBurst(row:Row):TriggerFilesystemBurst {
    return {triggerId:row.trigger_id,occurrenceKey:row.occurrence_key,projectId:row.project_id,branchId:row.branch_id,
      startedAt:row.started_at,lastAt:row.last_at,eventCount:row.event_count,changes:JSON.parse(row.changes_json),droppedPathEventCount:row.dropped_path_event_count};
  }
  getFilesystemTriggerBurst(triggerId:string):TriggerFilesystemBurst|undefined {
    const row=this.sqlite.prepare('SELECT * FROM trigger_filesystem_bursts WHERE trigger_id=?').get(triggerId) as Row|undefined;
    return row&&this.filesystemBurst(row);
  }
  listPendingFilesystemTriggerBursts(beforeId?:string,limit=100):TriggerFilesystemBurst[]{
    return (this.sqlite.prepare('SELECT * FROM trigger_filesystem_bursts WHERE (? IS NULL OR trigger_id>?) ORDER BY trigger_id LIMIT ?')
      .all(beforeId??null,beforeId??null,Math.max(1,Math.min(500,limit))) as Row[]).map(row=>this.filesystemBurst(row));
  }
  recordFilesystemTriggerEvent(input:{triggerId:string;path:string;eventType:string;maxCapturedPaths:number;now?:string}):TriggerFilesystemBurst {
    if(!input.path||input.path.length>4096||!['add','addDir','change','unlink','unlinkDir'].includes(input.eventType))throw new Error('Invalid filesystem Branch trigger event');
    if(!Number.isSafeInteger(input.maxCapturedPaths)||input.maxCapturedPaths<1||input.maxCapturedPaths>500)throw new Error('Filesystem Branch triggers capture between 1 and 500 paths');
    const now=input.now??new Date().toISOString();
    return this.transaction(()=>{
      const definition=this.row(input.triggerId);
      if(!definition||!definition.enabled||definition.source_kind!=='filesystem')throw new Error('Filesystem Branch trigger is unavailable');
      this.requireBranch(definition.branch_id);
      const existing=this.getFilesystemTriggerBurst(input.triggerId);
      if(!existing)this.sqlite.prepare(`INSERT INTO trigger_filesystem_bursts(trigger_id,occurrence_key,project_id,agent_id,branch_id,started_at,last_at,event_count,changes_json,dropped_path_event_count,updated_at)
        VALUES(?,?,?,NULL,?,?,?,1,?,0,?)`).run(definition.id,`filesystem:${randomUUID()}`,definition.project_id,definition.branch_id,now,now,stableJson([{path:input.path,types:[input.eventType]}]),now);
      else {
        const changes=existing.changes,changed=changes.find(item=>item.path===input.path);let dropped=existing.droppedPathEventCount;
        if(changed){if(!changed.types.includes(input.eventType))changed.types.push(input.eventType);}
        else if(changes.length<input.maxCapturedPaths)changes.push({path:input.path,types:[input.eventType]});else dropped++;
        this.sqlite.prepare('UPDATE trigger_filesystem_bursts SET last_at=?,event_count=event_count+1,changes_json=?,dropped_path_event_count=?,updated_at=? WHERE trigger_id=?')
          .run(now,stableJson(changes),dropped,now,input.triggerId);
      }
      return this.getFilesystemTriggerBurst(input.triggerId)!;
    })();
  }
  flushFilesystemTriggerBurst(triggerId:string,now=new Date().toISOString()):TriggerOccurrenceResult|undefined {
    return this.transaction(()=>{
      const burst=this.getFilesystemTriggerBurst(triggerId);if(!burst)return;
      const result=this.recordTriggerOccurrence({triggerId,occurrenceKey:burst.occurrenceKey,now,
        payload:{changes:burst.changes,lowLevelEventCount:burst.eventCount,capturedPathCount:burst.changes.length,startedAt:burst.startedAt,endedAt:burst.lastAt,
          ...(burst.droppedPathEventCount?{pathLimitReached:true,droppedPathEventCount:burst.droppedPathEventCount}:{})},
        provenance:{source:'branch_filesystem',watcher:'bound_workspace',contentInjected:false}});
      this.sqlite.prepare('DELETE FROM trigger_filesystem_bursts WHERE trigger_id=?').run(triggerId);return result;
    })();
  }


  recordTriggerOccurrence(input: RecordTriggerOccurrenceInput): TriggerOccurrenceResult {
    if (!input.triggerId.trim() || !input.occurrenceKey.trim() || !input.provenance.source?.trim()) throw new Error("Trigger identity, occurrence key and provenance source are required");
    const now = input.now ?? new Date().toISOString();
    return this.transaction(() => {
      const definition = this.row(input.triggerId);
      if (!definition) throw new Error("Automation not found");
      if (!definition.enabled && !input.allowDisabled) throw new Error("Automation is disabled");
      this.requireBranch(definition.branch_id);
      const hash = payloadHash({...(input.branchOperatorManual === true ? {branchAdmissionSource:"manual"} : {}),
        triggerId:definition.id,occurrenceKey:input.occurrenceKey,payload:input.payload,payloadMediaType:input.payloadMediaType ?? "application/json"},TRIGGER_CANONICAL_JSON_LIMITS);
      const existing = this.sqlite.prepare("SELECT id,input_hash,state FROM trigger_occurrences WHERE trigger_id=? AND occurrence_key=?")
        .get(input.triggerId,input.occurrenceKey) as Row | undefined;
      if (existing) {
        if (existing.input_hash !== hash) throw new Error("Automation occurrence idempotency conflict");
        return {occurrenceId:existing.id,state:existing.state,replayed:true};
      }
      const id = randomUUID(), snapshot = this.getTriggerDefinition(definition.id)!;
      this.sqlite.prepare(`INSERT INTO trigger_occurrences
        (id,trigger_id,occurrence_key,project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,input_hash,
         activation_config_json,state,attempts,available_at,occurred_at,created_at,updated_at,branch_id)
        VALUES (?,?,?,?,NULL,?,?,?,?,?,? ,?,'pending',0,?,?,?,?,?)`).run(id,definition.id,input.occurrenceKey,definition.project_id,`branch:${definition.branch_id}`,
          stableJson(input.payload,TRIGGER_CANONICAL_JSON_LIMITS),stableJson(input.provenance,TRIGGER_CANONICAL_JSON_LIMITS),
          stableJson({...snapshot,productScope:"branches"},TRIGGER_CANONICAL_JSON_LIMITS),input.payloadMediaType ?? "application/json",hash,
          stableJson(input.heldSchedule?{schedule:input.heldSchedule}:{}),now,now,now,now,definition.branch_id);
      if(input.heldSchedule)return {occurrenceId:id,state:'pending',replayed:false};
      const executionId = this.accept({admissionSource:input.branchOperatorManual === true ? "manual" : "automatic",triggerId:definition.id,branchId:definition.branch_id,
        occurrenceId:id,inputHash:hash,payload:input.payload,provenance:input.provenance,payloadMediaType:input.payloadMediaType ?? "application/json",now});
      this.sqlite.prepare("UPDATE trigger_occurrences SET branch_id=?,branch_execution_id=?,state='activated' WHERE id=?").run(definition.branch_id,executionId,id);
      return {occurrenceId:id,state:"activated",replayed:false};
    })();
  }

  recordScheduledTriggerOccurrence(input: RecordTriggerOccurrenceInput & {expectedNextFireAt:string;nextFireAt?:string;lastFiredAt:string}): TriggerOccurrenceResult {
    return this.transaction(() => {
      const row = this.row(input.triggerId);
      if (!row || !row.enabled || row.source_kind !== "schedule") throw new Error("Scheduled Automation is unavailable");
      if (row.next_fire_at !== input.expectedNextFireAt) throw new Error("Scheduled Automation cursor changed");
      const config=JSON.parse(row.source_config_json) as import('@ponderosa/core').TriggerScheduleConfig;
      const policy=config.scheduleKind==='once'?'queue_all':config.whenRunning??'queue_all';
      let result:TriggerOccurrenceResult;
      if(policy==='queue_all')result=this.recordTriggerOccurrence(input);
      else {
        // The source cursor and replacement of the latest held check share this
        // transaction. Original occurrence payloads/hashes/snapshots never change.
        const previous=this.sqlite.prepare(`SELECT id,activation_id,activation_config_json FROM trigger_occurrences
          WHERE trigger_id=? AND state='pending' ORDER BY created_at DESC,id DESC LIMIT 1`).get(row.id) as Row|undefined;
        const combine=previous&&(!previous.activation_id||this.cancelUndeliveredUpdate?.(previous.id,input.now??new Date().toISOString()));
        const prior=combine?JSON.parse(previous.activation_config_json).schedule as TriggerOccurrenceDto['schedule']:undefined;
        const payload=input.payload as {missedCount?:number;enumeratedCount?:number;truncatedCronHistory?:boolean;exactIntervalRange?:{count:number}};
        const count=payload.exactIntervalRange?.count??payload.missedCount??payload.enumeratedCount??1;
        const total=(prior?.eventCount??0)+count;
        const schedule:NonNullable<TriggerOccurrenceDto['schedule']>={policy,firstScheduledAt:prior?.firstScheduledAt??input.expectedNextFireAt,
          lastScheduledAt:input.lastFiredAt,eventCount:Math.min(Number.MAX_SAFE_INTEGER,total),delivery:'held',
          ...(payload.truncatedCronHistory||prior?.eventCountExact===false||!Number.isSafeInteger(total)?{eventCountExact:false}:{})};
        result=this.recordTriggerOccurrence({...input,heldSchedule:schedule});
        if(combine&&previous.id!==result.occurrenceId){
          const old=JSON.parse(previous.activation_config_json);old.schedule={...old.schedule,delivery:'combined',combinedIntoOccurrenceId:result.occurrenceId};
          this.sqlite.prepare(`UPDATE trigger_occurrences SET state='cancelled',activation_config_json=?,cancelled_at=?,updated_at=?,last_error=NULL WHERE id=? AND state='pending'`)
            .run(stableJson(old),input.now??new Date().toISOString(),input.now??new Date().toISOString(),previous.id);
        }
      }
      this.sqlite.prepare(`UPDATE trigger_definitions SET next_fire_at=?,last_fired_at=?,enabled=CASE WHEN ? IS NULL THEN 0 ELSE enabled END,updated_at=? WHERE id=? AND next_fire_at=?`)
        .run(input.nextFireAt ?? null,input.lastFiredAt,input.nextFireAt ?? null,input.now ?? new Date().toISOString(),input.triggerId,input.expectedNextFireAt);
      return result;
    })();
  }

  getTriggerOccurrence(id: string): TriggerOccurrenceDto | undefined {
    const row = this.sqlite.prepare("SELECT * FROM trigger_occurrences WHERE id=?").get(id) as Row | undefined;
    return row && {id:row.id,artifactId:`trigger-occurrence:${row.id}`,triggerId:row.trigger_id,projectId:row.project_id,branchId:row.branch_id,
      ...(row.branch_execution_id ? {branchExecutionId:row.branch_execution_id} : {}),state:row.state,payload:JSON.parse(row.payload_json),provenance:JSON.parse(row.provenance_json),
      payloadMediaType:row.payload_media_type,inputHash:row.input_hash,triggerSnapshot:JSON.parse(row.trigger_snapshot_json),
      ...(row.last_error ? {lastError:row.last_error} : {}),...(JSON.parse(row.activation_config_json).schedule?{schedule:JSON.parse(row.activation_config_json).schedule}:{}),occurredAt:row.occurred_at,createdAt:row.created_at,updatedAt:row.updated_at};
  }

  /** Called only inside the scheduler's admission transaction after capacity is checked. */
  combineHeldScheduleChecks(olderId:string,newerId:string,now:string):boolean {
    return this.transaction(()=>{
      const get=(id:string)=>this.sqlite.prepare("SELECT * FROM trigger_occurrences WHERE id=? AND state='pending' AND activation_id IS NULL").get(id) as Row|undefined;
      const older=get(olderId),newer=get(newerId);
      if(!older||!newer||older.id===newer.id||older.trigger_id!==newer.trigger_id||older.branch_id!==newer.branch_id)return false;
      const a=JSON.parse(older.activation_config_json),b=JSON.parse(newer.activation_config_json);if(!a.schedule||!b.schedule)return false;
      const total=a.schedule.eventCount+b.schedule.eventCount;
      b.schedule={...b.schedule,firstScheduledAt:[a.schedule.firstScheduledAt,b.schedule.firstScheduledAt].sort()[0],
        lastScheduledAt:[a.schedule.lastScheduledAt,b.schedule.lastScheduledAt].sort().at(-1),eventCount:Math.min(Number.MAX_SAFE_INTEGER,total),
        ...(a.schedule.eventCountExact===false||b.schedule.eventCountExact===false||!Number.isSafeInteger(total)?{eventCountExact:false}:{})};
      a.schedule={...a.schedule,delivery:'combined',combinedIntoOccurrenceId:newerId};
      this.sqlite.prepare('UPDATE trigger_occurrences SET activation_config_json=?,updated_at=? WHERE id=?').run(stableJson(b),now,newerId);
      this.sqlite.prepare("UPDATE trigger_occurrences SET state='cancelled',activation_config_json=?,cancelled_at=?,updated_at=?,last_error=NULL WHERE id=?").run(stableJson(a),now,now,olderId);
      return true;
    })();
  }

  /** Called only inside the scheduler's admission transaction after capacity is checked. */
  activateScheduledCheck(id:string,now:string):string|undefined {
    const row=this.sqlite.prepare("SELECT * FROM trigger_occurrences WHERE id=? AND state='pending' AND activation_id IS NULL").get(id) as Row|undefined;
    if(!row)return;
    const config=JSON.parse(row.activation_config_json);if(!config.schedule)return;
    const definition=this.row(row.trigger_id);
    if(!definition?.enabled||!this.sqlite.prepare('SELECT 1 FROM branches WHERE id=? AND enabled=1 AND deleting=0 AND trigger_id=?').get(row.branch_id,row.trigger_id))return;
    const executionId=this.accept({admissionSource:'automatic',triggerId:row.trigger_id,branchId:row.branch_id,occurrenceId:row.id,inputHash:row.input_hash,
      payload:JSON.parse(row.payload_json),provenance:JSON.parse(row.provenance_json),payloadMediaType:row.payload_media_type,now});
    config.schedule.delivery='run';
    this.sqlite.prepare("UPDATE trigger_occurrences SET state='activated',branch_execution_id=?,activation_config_json=?,updated_at=?,last_error=NULL WHERE id=? AND state='pending'")
      .run(executionId,stableJson(config),now,id);
    return executionId;
  }

  listTriggerOccurrences(triggerId: string, limit = 100): TriggerOccurrenceDto[] {
    return (this.sqlite.prepare("SELECT id FROM trigger_occurrences WHERE trigger_id=? ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(triggerId,Math.max(1,Math.min(500,limit))) as {id:string}[]).map(row => this.getTriggerOccurrence(row.id)!);
  }
}
