/** Mutations exposed only for the two explicitly activated candidate UIs. */
export function candidateMutationAllowed(method,pathname,body,installations){
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 const active=installations.filter(i=>i.deliveryMode==='user-ui'&&i.supported===true);
 const message=pathname.match(/^\/api\/(?:branches\/engine\/)?agents\/([^/]+)\/messages$/);
 if(method==='POST'&&message){
  return active.some(i=>i.spokespersonId===message[1])&&Object.keys(body).every(k=>['text','idempotencyKey','activeRunDelivery'].includes(k))&&typeof body.text==='string'&&Boolean(body.text.trim())&&typeof body.idempotencyKey==='string'&&Boolean(body.idempotencyKey)&&['queue','steer'].includes(body.activeRunDelivery);
 }
 const check=pathname.match(/^\/api\/branches\/([^/]+)\/executions$/);
 if(method==='POST'&&check)return active.some(i=>i.branchId===check[1])&&Object.keys(body).every(k=>['occurrenceKey','input'].includes(k))&&typeof body.occurrenceKey==='string'&&Boolean(body.occurrenceKey)&&typeof body.input==='string';
 const trigger=pathname.match(/^\/api\/(?:branches\/engine\/)?triggers\/([^/]+)$/);
 if(method==='PATCH'&&trigger)return active.some(i=>i.triggerId===trigger[1]&&body.reviewedDefinition?.branchId===i.branchId&&body.reviewedDefinition?.id===i.triggerId)&&Object.keys(body).every(k=>['enabled','reviewedDefinition'].includes(k))&&typeof body.enabled==='boolean';
 return false;
}
