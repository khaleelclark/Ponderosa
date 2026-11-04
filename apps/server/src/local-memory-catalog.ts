const str={type:'string',minLength:1};const destination={type:'string',enum:['chat','global']};
const guidance = {
 save: 'Store a fact in the explicit destination: chat for this Chat, global for installation-wide memory. Chat visibility defaults to team; private is same-Agent only and unsupported for global.',
 update: 'Create a new physical version using a returned chunk_id and its destination. Existing-source read authority is required; retain the returned lineage.',
 forget: 'Forget a returned chunk_id in its destination. Existing-source read authority is required; this is not a hard delete.',
 get: 'Fetch a returned physical chunk_id. Omit source to resolve across both authorized Chat and global memory; use source only to deliberately narrow the lookup.',
 search: 'Start with one search with source omitted: it searches both authorized Chat and global memory together. A missing or revoked global-read grant leaves Chat-only results; it does not prove global memory is empty. Do not issue separate Chat/global searches by default. Use returned scope and chunk_id for attribution and follow-up; do not infer provenance from result text.',
 history: 'Retrieve version lineage for a returned chunk_id. Omit source for both authorized scopes; use source only to deliberately narrow the lookup.',
} as const;
const definitions=[
 ['save',{text:str,destination,visibility:{type:'string',enum:['team','private']}},['text','destination']],
 ['update',{chunk_id:str,text:str,destination},['chunk_id','text','destination']],
 ['forget',{chunk_id:str,destination},['chunk_id','destination']],
 ['get',{chunk_id:str,source:destination},['chunk_id']],
 ['search',{query:str,source:destination,top_k:{type:'integer',minimum:1,maximum:20},include_history:{type:'boolean'}},['query']],
 ['history',{chunk_id:str,source:destination},['chunk_id']],
] as const;
export const localMemoryTools=definitions.map(([operation,properties,required])=>({name:`ponderosa_local_memory_${operation}`,description:`${guidance[operation]} Host stamps actor/Run/source provenance; never supply or invent it. Never capture hidden DM/provider context. Chat and global writes follow human capability settings. Use physical chunk_id/version lineage, not logical IDs, expectedRevision, commandKey or exactly-once receipts.`,inputSchema:{type:'object',properties,required:[...required],additionalProperties:false}}));
/** Fixed, value-free input errors keep model retries actionable without echoing
 * authored text, unknown field names or potentially sensitive arguments. */
export class MemoryArgumentError extends Error{
 constructor(message:string){super(message);this.name='MemoryArgumentError';}
}
export function validateMemoryCall(operation:string,args:unknown):Record<string,any>{
 const d=definitions.find(x=>x[0]===operation);
 if(!d)throw new MemoryArgumentError('Unsupported memory operation');
 if(!args||typeof args!=='object'||Array.isArray(args))throw new MemoryArgumentError('Memory arguments must be an object');
 const a=args as Record<string,any>;
 if(['memoryId','expectedRevision','commandKey'].some(k=>Object.hasOwn(a,k)))throw new MemoryArgumentError('Removed logical ID/revision/idempotency arguments; use physical chunk_id');
 if(Object.keys(a).some(k=>!Object.hasOwn(d[1],k)))throw new MemoryArgumentError('Memory arguments contain an unsupported parameter');
 const missing=d[2].find(k=>!Object.hasOwn(a,k));
 if(missing)throw new MemoryArgumentError(`Missing required memory parameter: ${missing}`);
 for(const k of ['text','chunk_id','query']){
  const max=k==='text'?32000:8000;
  if(Object.hasOwn(a,k)&&(typeof a[k]!=='string'||!a[k].trim()||a[k].length>max))throw new MemoryArgumentError(`${k} must be a nonempty string of at most ${max} characters`);
 }
 for(const k of ['destination','source'])if(Object.hasOwn(a,k)&&!['chat','global'].includes(a[k]))throw new MemoryArgumentError(`${k} must be chat or global`);
 if(Object.hasOwn(a,'visibility')&&!['team','private'].includes(a.visibility))throw new MemoryArgumentError('visibility must be team or private');
 if(Object.hasOwn(a,'include_history')&&typeof a.include_history!=='boolean')throw new MemoryArgumentError('include_history must be boolean');
 if(Object.hasOwn(a,'top_k')&&(!Number.isInteger(a.top_k)||a.top_k<1||a.top_k>20))throw new MemoryArgumentError('top_k must be an integer from 1 to 20');
 return structuredClone(a);
}
