import type Database from 'better-sqlite3';

/** Reservation can precede Chat/Agent existence and survives failed import/restart. */
export function destinationAdmissionHeld(db:Database.Database,agentId?:string,conversationId?:string):boolean {
  // Generic contained bindings retain their original preparing operation even
  // when Project projections are unavailable. No dispatch or automatic rollback.
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_creation_operations'").get()&&db.prepare(`SELECT 1 FROM agent_creation_operations o WHERE o.status!='completed' AND o.status!='rolled_back'
    AND EXISTS(SELECT 1 FROM json_each(o.result_json,'$.importedProjectRootBindings') b
      WHERE json_extract(b.value,'$.conversationId')=? OR EXISTS(SELECT 1 FROM json_each(b.value,'$.memberIds') m WHERE m.value=?)) LIMIT 1`)
    .get(conversationId??null,agentId??null))return true;
  // Import-only recovery quarantine precedes rebuildable Project/Agent rows.
  // A missing projection must never erase the exact durable no-dispatch fence.
  if((db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('branch_installation_plans','branch_installation_resources')").get() as {total:number}).total===2&&db.prepare(
    "SELECT 1 FROM branch_installation_plans p WHERE EXISTS(SELECT 1 FROM json_each(p.preview_json,'$.workingDataApplication.recoveryHolds') h WHERE json_extract(h.value,'$.state')='unavailable' AND (EXISTS(SELECT 1 FROM json_each(h.value,'$.memberIds') m WHERE m.value=? OR m.value=?) OR EXISTS(SELECT 1 FROM branch_installation_resources r WHERE r.staging_plan_id=p.id AND r.state!='deleted' AND (r.local_id=? OR r.local_id=?)))) LIMIT 1"
  ).get(agentId??null,conversationId??null,agentId??null,conversationId??null))return true;
  if(db.prepare(`SELECT 1 FROM coordination_destination_retirements d WHERE (d.conversation_id=? OR EXISTS(SELECT 1 FROM json_each(d.receipt_json,'$.resources') r WHERE json_extract(r.value,'$.destination.conversationId')=?))
    OR EXISTS(SELECT 1 FROM json_each(d.members_json) m WHERE json_extract(m.value,'$.agent_id')=?)
    OR EXISTS(SELECT 1 FROM agents a WHERE a.id=? AND (a.conversation_id=d.conversation_id OR EXISTS(SELECT 1 FROM json_each(d.receipt_json,'$.resources') r WHERE json_extract(r.value,'$.destination.conversationId')=a.conversation_id))) LIMIT 1`)
    .get(conversationId??null,conversationId??null,agentId??null,agentId??null))return true;
  if(db.prepare(`SELECT 1 FROM coordination_destination_group_chats g
    JOIN coordination_destination_admissions d ON d.id=g.admission_id WHERE d.state!='admitted'
    AND (g.conversation_id=? OR EXISTS(SELECT 1 FROM agents a WHERE a.id=? AND a.conversation_id=g.conversation_id)) LIMIT 1`)
    .get(conversationId??null,agentId??null))return true;
  return Boolean(db.prepare(`SELECT 1 FROM coordination_destination_admissions d
    WHERE d.state!='admitted' AND (d.conversation_id=?
      OR EXISTS(SELECT 1 FROM coordination_destination_members m WHERE m.admission_id=d.id AND m.agent_id=?)
      OR EXISTS(SELECT 1 FROM agents a WHERE a.id=? AND a.conversation_id=d.conversation_id)) LIMIT 1`)
    .get(conversationId??null,agentId??null,agentId??null));
}
export function requireDestinationAdmitted(db:Database.Database,agentId?:string,conversationId?:string):void {
  if(destinationAdmissionHeld(db,agentId,conversationId))throw Error('Destination identities are staged; historical admission has not committed');
}
