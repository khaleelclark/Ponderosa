const str={type:'string',minLength:1};const destination={type:'string',enum:['chat','global']};
const definitions=[
 ['save',{text:str,destination,visibility:{type:'string',enum:['team','private']}},['text','destination']],
 ['update',{chunk_id:str,text:str,destination},['chunk_id','text','destination']],
 ['forget',{chunk_id:str,destination},['chunk_id','destination']],
 ['get',{chunk_id:str,source:destination},['chunk_id']],
 ['search',{query:str,source:destination,top_k:{type:'integer',minimum:1,maximum:20},include_history:{type:'boolean'}},['query']],
 ['history',{chunk_id:str,source:destination},['chunk_id']],
] as const;
export const localMemoryTools=definitions.map(([operation,properties,required])=>({name:`ponderosa_local_memory_${operation}`,description:`Authorized physical-source ${operation}. Explicit write destination; Chat team/private audience and trusted provenance. Physical chunk_id/version lineage; no logical IDs, expectedRevision, commandKey or exactly-once receipts. Never capture hidden DM/provider context. Agents cannot write global.`,inputSchema:{type:'object',properties,required:[...required],additionalProperties:false}}));
export function validateMemoryCall(operation:string,args:unknown):Record<string,any>{
 const d=definitions.find(x=>x[0]===operation);if(!d||!args||typeof args!=='object'||Array.isArray(args))throw Error('Unsupported memory operation or arguments');
 const a=args as Record<string,any>;if(['memoryId','expectedRevision','commandKey'].some(k=>k in a))throw Error('Removed reliable-memory logical ID/revision/idempotency arguments; use physical chunk_id');
 if(Object.keys(a).some(k=>!(k in d[1]))||d[2].some(k=>!(k in a)))throw Error('Invalid memory arguments');
 for(const k of ['text','chunk_id','query'])if(k in a&&(typeof a[k]!=='string'||!a[k].trim()||a[k].length>(k==='text'?32000:8000)))throw Error('Invalid bounded memory input');
 for(const k of ['destination','source'])if(k in a&&!['chat','global'].includes(a[k]))throw Error('Invalid memory destination/source');
 if('visibility'in a&&!['team','private'].includes(a.visibility))throw Error('Invalid memory visibility');if('include_history'in a&&typeof a.include_history!=='boolean')throw Error('Invalid history flag');if('top_k'in a&&(!Number.isInteger(a.top_k)||a.top_k<1||a.top_k>20))throw Error('Invalid result bound');return structuredClone(a);
}
