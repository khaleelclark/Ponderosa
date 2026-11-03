import type {ReviewedMetadataActivation,ReviewedUserDataActivation} from '@ponderosa/core';
import {portablePathChoice,sourcePathChoice} from './portablePathChoices';
/** Bounded, display-only native data summary. The server validates original bytes and authority. */
export interface NativeDataPreview {
 git:boolean;harness:boolean;
 sourceRoots:Array<{rootRef:string;sourcePath:string}>;
 metadata?:{sourceQualifier:string;rootRefs:string[];principals:Array<{kind:'user'|'group';sourceId:string}>;fifoCount:number;unsupportedNodes:number};
 warning?:string;
}
const maximumManifestBytes=48*1024*1024;
async function artifactText(artifact:Record<string,unknown>):Promise<string> {
 if(typeof artifact.dataBase64!=='string'||artifact.dataBase64.length>Math.ceil(maximumManifestBytes/3)*4)throw Error('Native review exceeds its 48 MiB preview bound');
 const raw=atob(artifact.dataBase64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
 if(artifact.dataEncoding!==undefined&&artifact.dataEncoding!=='gzip')throw Error('Unsupported native review encoding');
 const stream=artifact.dataEncoding==='gzip'?new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')):new Blob([bytes]).stream();
 const reader=stream.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumManifestBytes)throw Error('Native review exceeds its 48 MiB preview bound');text+=decoder.decode(next.value,{stream:true});}return text+decoder.decode();}
 finally {await reader.cancel();}
}
export async function nativeDataPreview(nodes:unknown[]):Promise<NativeDataPreview> {
 const result:NativeDataPreview={git:false,harness:false,sourceRoots:[]};
 const roots=new Set<string>(),principals=new Map<string,{kind:'user'|'group';sourceId:string}>(),sources=new Set<string>();
 let fifoCount=0,unsupportedNodes=0;
 const principal=(kind:'user'|'group',sourceId:string)=>{if(!/^(?:0|[1-9][0-9]*)$/.test(sourceId))throw Error('Invalid native owner identity');principals.set(kind+':'+sourceId,{kind,sourceId});};
 try {
  for(const candidate of nodes){
   const node=candidate as Record<string,any>;
   const file=node?.workingFiles?.find((item:any)=>item.path==='.ponderosa-portable-review/user-data.json');
   if(!file)continue;
   const artifact=node.artifacts?.find((item:any)=>item.ref===file.artifactRef);if(!artifact)throw Error('Native review original is missing');
   const manifest=JSON.parse(await artifactText(artifact));
   if(manifest.version!==1||manifest.activation!=='inert_review_only')throw Error('Native review format is unsupported');
   result.git ||= manifest.selection?.git===true&&Boolean(manifest.git);
   const harnessPath=(entry:{path?:unknown})=>typeof entry.path==='string'&&(entry.path==='.mcp.json'||entry.path==='.claude'||entry.path.startsWith('.claude/')||entry.path==='.codex'||entry.path.startsWith('.codex/'));
   result.harness ||= manifest.selection?.harness===true&&Boolean(manifest.providerFiles?.some(harnessPath)||manifest.providerDirectories?.some(harnessPath));
   for(const binding of manifest.associationReview??[])for(const source of binding.capture?.roots??[]){
    if(typeof source.rootRef==='string'&&typeof source.sourcePath==='string'&&!result.sourceRoots.some(item=>item.rootRef===source.rootRef&&item.sourcePath===source.sourcePath))result.sourceRoots.push({rootRef:source.rootRef,sourcePath:source.sourcePath});
   }
   const metadata=manifest.filesystemMetadata;if(!metadata)continue;
   if(metadata.version!==1||typeof metadata.sourceQualifier!=='string'||!Array.isArray(metadata.nodes)||!Array.isArray(metadata.persistentNodes))throw Error('Native metadata summary is invalid');
   sources.add(metadata.sourceQualifier);roots.add(node.workingRootRef??node.ref);
   for(const entry of [...metadata.nodes,...metadata.persistentNodes]){principal('user',entry.ownerId);principal('group',entry.groupId);}
   for(const entry of [...metadata.nodes,...metadata.persistentNodes.flatMap((node:any)=>node.extendedMetadata?[node.extendedMetadata]:[])])for(const encoded of [entry.accessAclBase64,entry.defaultAclBase64]){
    if(encoded===null)continue;
    if(typeof encoded!=='string')throw Error('Invalid ACL evidence');
    const acl=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),view=new DataView(acl.buffer);
    if(acl.length<4||(acl.length-4)%8||view.getUint32(0,true)!==2)throw Error('Unsupported ACL evidence');
    for(let offset=4;offset<acl.length;offset+=8){const tag=view.getUint16(offset,true);if(tag===2||tag===8)principal(tag===2?'user':'group',String(view.getUint32(offset+4,true)));}
   }
   fifoCount+=metadata.persistentNodes.filter((entry:any)=>entry.kind==='fifo').length;
   unsupportedNodes+=metadata.persistentNodes.filter((entry:any)=>entry.kind!=='fifo').length;
  }
  if(sources.size>1)throw Error('Selected folders have different source owner namespaces; import metadata separately');
  if(sources.size)result.metadata={sourceQualifier:[...sources][0]!,rootRefs:[...roots],principals:[...principals.values()].sort((a,b)=>(a.kind+':'+a.sourceId).localeCompare(b.kind+':'+b.sourceId)),fifoCount,unsupportedNodes};
 }catch(error){result.metadata=undefined;result.warning=error instanceof Error?error.message:String(error);}
 return result;
}

export type NativeImportChoices={reviewedUserDataActivation?:ReviewedUserDataActivation;reviewedMetadataActivation?:ReviewedMetadataActivation};
export function nativeImportChoiceError(value:NativeImportChoices,summary?:NativeDataPreview):string|undefined {
 const native=value.reviewedUserDataActivation as (ReviewedUserDataActivation&{gitPathMappings?:Array<{source:string;destination:string}>})|undefined;
 if(native?.gitPathMappings?.some(mapping=>!sourcePathChoice(mapping.source)||!portablePathChoice(mapping.destination)))return 'Map each old settings path to an included destination folder or file. Use forward slashes for source paths.';
 const metadata=value.reviewedMetadataActivation;
 if(summary&&(native?.git&&!summary.git||native?.harness&&!summary.harness))return 'Included native settings changed. Review the package again.';
 if(metadata){
  const complete=metadata.destinationQualifier&&metadata.rootRefs.length&&new Set(metadata.principalMappings.map(mapping=>mapping.kind+':'+mapping.destinationId)).size===metadata.principalMappings.length&&metadata.principalMappings.every(mapping=>/^(?:0|[1-9][0-9]{0,9})$/.test(mapping.destinationId)&&Number(mapping.destinationId)<=4294967294);
  const source=summary?.metadata;
  if(!complete||summary&&(!source||metadata.sourceQualifier!==source.sourceQualifier||source.unsupportedNodes||source.fifoCount&&!metadata.fifo||source.rootRefs.length!==metadata.rootRefs.length||source.rootRefs.some(ref=>!metadata.rootRefs.includes(ref))||source.principals.some(principal=>!metadata.principalMappings.some(mapping=>mapping.kind===principal.kind&&mapping.sourceId===principal.sourceId))))return 'Choose distinct destination owners for all included permissions and confirm any named pipes.';
 }

}

/** Only the server-composed metadata subset can authorize grouped application roots. */
export function nativePreviewForGroupedRoots(summary:NativeDataPreview|undefined,metadataRoots:readonly string[]|undefined):NativeDataPreview|undefined {
 if(!summary?.metadata)return summary;
 return {...summary,sourceRoots:[],metadata:{...summary.metadata,rootRefs:[...(metadataRoots??[])]},...(!metadataRoots?.length?{warning:'Review the grouped folders to identify metadata-bearing destinations.'}:{})};
}
