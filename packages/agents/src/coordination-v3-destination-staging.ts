import type Database from 'better-sqlite3';

/** Reservation can precede Chat/Agent existence and survives failed import/restart. */
export function destinationAdmissionHeld(db:Database.Database,agentId?:string,conversationId?:string):boolean {
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
