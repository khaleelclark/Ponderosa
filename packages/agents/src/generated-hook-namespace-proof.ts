import path from 'node:path';
import type {CanonicalGeneratedHooksProof,GeneratedHookIdentity} from '@ponderosa/core';

/** Internal record admission only. Filesystem verification belongs to the
 * fenced native writer and retained-original reader, never a user receipt. */
export function validateGeneratedHookNamespaceProof(proof:CanonicalGeneratedHooksProof):void {
 const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Generated hook proof has unexpected fields');};
 exact(proof,['schema','operationId','sourceOriginalSha256','root','namespace','links']);exact(proof.root,['device','inode']);
 const unsigned=/^(?:0|[1-9][0-9]{0,31})$/,signed=/^(?:0|-?[1-9][0-9]{0,31})$/;
 if(proof.schema!=='ponderosa.generated-hook-namespace.v1'||typeof proof.operationId!=='string'||!proof.operationId||proof.operationId.length>256||/[\x00-\x20\x7f]/.test(proof.operationId)||!/^([a-f0-9]{64})$/.test(proof.sourceOriginalSha256)||![proof.root.device,proof.root.inode].every(value=>typeof value==='string'&&unsigned.test(value))||!Array.isArray(proof.links)||proof.links.length>1000)throw new Error('Generated hook proof identity is malformed');
 const keys=['device','inode','mode','nlink','uid','gid','size','mtimeNs','ctimeNs'] as const;
 const identity=(value:GeneratedHookIdentity,kind:bigint)=>{exact(value,keys);if(keys.some(key=>typeof value[key]!=='string'||!(key==='mtimeNs'||key==='ctimeNs'?signed:unsigned).test(value[key]))||(BigInt(value.mode)&0o170000n)!==kind||BigInt(value.nlink)<1n)throw new Error('Generated hook inode identity is malformed');};
 identity(proof.namespace,0o040000n);
 const names=new Set<string>();
 for(const link of proof.links){exact(link,['name','text','identity']);identity(link.identity,0o120000n);if(typeof link.name!=='string'||!/^[a-f0-9]{64}$/.test(link.name)||names.has(link.name)||typeof link.text!=='string'||!link.text||Buffer.byteLength(link.text)>8192||/[\x00-\x1f\x7f\\]/.test(link.text)||link.text.startsWith('/')||/^[a-z]:/i.test(link.text)||path.posix.normalize(link.text)!==link.text||link.identity.nlink!=='1'||link.identity.uid!==proof.namespace.uid)throw new Error('Generated hook link declaration is malformed');names.add(link.name);}
}
