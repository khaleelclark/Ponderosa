import type Database from 'better-sqlite3';

/** SQL expressions are internal constants, never caller-provided identifiers.
 * Resources keep this exact plan link while publication is unfinished, even
 * when a tree import has moved them to a different descendant Branch. */
export function branchInstallationHoldSql(agent:string,chat:string):string {
 return `EXISTS(SELECT 1 FROM branch_installation_resources held_resource
   LEFT JOIN branch_installation_plans held_plan ON held_plan.id=held_resource.staging_plan_id
   WHERE held_resource.staging_plan_id IS NOT NULL
     AND (held_plan.id IS NULL OR held_plan.state!='completed')
     AND (held_resource.local_id=${agent} OR held_resource.local_id=${chat}
       OR EXISTS(SELECT 1 FROM agents held_agent WHERE held_agent.id=${agent}
         AND held_agent.conversation_id=held_resource.local_id)))`;
}

/** Legacy coordination-only fixtures may have neither Branch table. A partial
 * schema is not proof of absence and must not authorize a new dispatch. */
export function branchInstallationTables(db:Database.Database):'none'|'ready'|'partial' {
 const {total}=db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('branch_installation_plans','branch_installation_resources')").get() as {total:number};
 return total===0?'none':total===2?'ready':'partial';
}
export function branchInstallationHeld(db:Database.Database,agentId?:string,conversationId?:string):boolean {
 if(!agentId&&!conversationId)return false;
 const tables=branchInstallationTables(db);
 if(tables==='none')return false;
 if(tables==='partial')return true;
 return Boolean(db.prepare(`SELECT 1 WHERE ${branchInstallationHoldSql('?1','?2')}`).get(agentId??null,conversationId??null));
}
