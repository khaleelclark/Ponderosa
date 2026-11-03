import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyExactFileMetadata,applyExtendedMetadata,inspectExtendedMetadata,inspectPersistentNode,createPersistentNode,type ExtendedMetadataEvidence} from '@ponderosa/native-host';
import type {PortableFilesystemMetadata,ReviewedMetadataActivation,ReviewedUserDataSelection,PortableWorkingLinkDto} from '@ponderosa/core';
import {inventoryWorkingFolder,portableWorkingPath,type WorkingFolderInventory} from './portable-working-files.js';
import type {GitExportCapture} from './portable-reviewed-user-data.js';
import {assertPortableSecretsAbsent,isPortableSecretField} from './portable-secrets.js';

const maximumBytes=16*1024*1024;
async function withMetadataHandle<T>(handle:Awaited<ReturnType<typeof fs.open>>,operation:()=>Promise<T>,mutationPossible=false):Promise<T>{
  let primary:unknown;
  try{return await operation();}catch(error){primary=error;throw error;}
  finally{
    try{await handle.close();}catch(cleanup){
      const failure=primary as {code?:string;partialStatePossible?:boolean;observed?:unknown}|undefined;
      throw Object.assign(new Error('Filesystem metadata descriptor cleanup failed; preserve source and destination',{cause:primary??cleanup}),{code:failure?.code??'ERR_PORTABLE_METADATA_CLEANUP',partialStatePossible:mutationPossible||failure?.partialStatePossible===true,observed:failure?.observed??null,cleanupErrors:[cleanup]});
    }
  }
}

function fail(message:string):never{throw new Error(message);}
function keys(value:unknown,fields:string[]):void{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(field=>!Object.hasOwn(value,field)))fail('Invalid filesystem metadata fields');
}
function decimal(value:unknown,signed=false):asserts value is string{
  if(typeof value!=='string'||!(signed?/^-?(?:0|[1-9][0-9]{0,19})$/:/^(?:0|[1-9][0-9]{0,9})$/).test(value)||!signed&&BigInt(value)>4294967294n)fail('Invalid filesystem metadata integer');
}
function bytes(value:unknown,maximum=65536):Buffer{
  if(typeof value!=='string'||value.length>Math.ceil(maximum/3)*4)fail('Filesystem metadata exceeds its byte bound');
  const data=Buffer.from(value as string,'base64');
  if(data.length>maximum||data.toString('base64')!==value)fail('Invalid filesystem metadata encoding');
  return data;
}
function relative(value:unknown,root=false):asserts value is string{
  if(root&&value==='.')return;
  if(typeof value!=='string')fail('Invalid filesystem metadata path');
  portableWorkingPath(value);
}
function inspectSecrets(data:Buffer):void{
  if(data.includes(Buffer.from('-----BEGIN PRIVATE KEY-----'))||data.includes(Buffer.from('-----BEGIN RSA PRIVATE KEY-----')))fail('Known private-key material cannot be exported as metadata');
  try{assertPortableSecretsAbsent(new TextDecoder('utf-8',{fatal:true}).decode(data),'Selected filesystem metadata');}
  catch(error){if(!(error instanceof TypeError))throw error;}
}
/** Observed local namespace qualification, not a permission token or principal equivalence. */
export async function filesystemMetadataProvenance():Promise<{qualifier:string;ownerId:string;groupId:string}>{
  if(process.platform!=='linux'||!process.getuid||!process.getgid)fail('Filesystem metadata transport currently requires Linux');
  const [machine,userNamespace,mountNamespace]=await Promise.all([fs.readFile('/etc/machine-id'),fs.stat('/proc/self/ns/user',{bigint:true}),fs.stat('/proc/self/ns/mnt',{bigint:true})]);
  const qualifier='linux:'+createHash('sha256').update(machine).update(':').update(String(userNamespace.ino)).update(':').update(String(mountNamespace.ino)).digest('hex');
  return {qualifier,ownerId:String(process.geteuid?.()??process.getuid!()),groupId:String(process.getegid?.()??process.getgid!())};
}
export function validateFilesystemMetadata(value:unknown,selection:ReviewedUserDataSelection):asserts value is PortableFilesystemMetadata{
  keys(value,['version','sourceQualifier','allNamespacesComplete','nodes','persistentNodes']);
  const metadata=value as PortableFilesystemMetadata;
  if(metadata.version!==1||metadata.allNamespacesComplete!==false||typeof metadata.sourceQualifier!=='string'||!/^linux:[a-f0-9]{64}$/.test(metadata.sourceQualifier)||!Array.isArray(metadata.nodes)||!Array.isArray(metadata.persistentNodes)||metadata.nodes.length+metadata.persistentNodes.length>10000)fail('Invalid selected filesystem metadata');
  if(!selection.extendedMetadata&&metadata.nodes.length||!selection.persistentNodes&&metadata.persistentNodes.length)fail('Filesystem metadata differs from selected families');
  const paths=new Set<string>();let total=0;
  for(const node of metadata.nodes){
    keys(node,['path','kind','mode','mtimeNs','ownerId','groupId','userAttributes','accessAclBase64','defaultAclBase64']);
    relative(node.path,true);
    if(paths.has(node.path)||!['file','directory'].includes(node.kind)||node.path==='.'&&node.kind!=='directory'||!Number.isInteger(node.mode)||node.mode<0||node.mode>0o7777||!Array.isArray(node.userAttributes)||node.userAttributes.length>256)fail('Invalid filesystem metadata node');
    paths.add(node.path);decimal(node.ownerId);decimal(node.groupId);decimal(node.mtimeNs,true);
    const names=new Set<string>();
    for(const attribute of node.userAttributes){
      keys(attribute,['nameBase64','valueBase64']);const name=bytes(attribute.nameBase64,255),data=bytes(attribute.valueBase64);
      if(name.length<6||!name.subarray(0,5).equals(Buffer.from('user.'))||name.includes(0)||names.has(attribute.nameBase64)||!selection.extendedMetadata?.userXattrs)fail('Invalid selected user attribute');
      if(isPortableSecretField(name.subarray(5).toString('utf8')))fail('Known secret attribute fields cannot be exported');
      inspectSecrets(name);inspectSecrets(data);names.add(attribute.nameBase64);total+=name.length+data.length;
    }
    for(const acl of [node.accessAclBase64,node.defaultAclBase64]){
      if(acl!==null){const data=bytes(acl);if(!selection.extendedMetadata?.posixAcl)fail('Unselected POSIX ACL');total+=data.length;}
    }
    if(node.kind==='file'&&node.defaultAclBase64!==null)fail('Regular files cannot have a default ACL');
  }
  for(const node of metadata.persistentNodes){
    keys(node,['path','kind','mode','mtimeNs','ownerId','groupId','deviceMajor','deviceMinor']);relative(node.path);
    if(paths.has(node.path)||!['fifo','socket','character','block'].includes(node.kind)||!Number.isInteger(node.mode)||node.mode<0||node.mode>0o7777)fail('Invalid persistent-node metadata');
    if(node.kind==='fifo'?!selection.persistentNodes?.fifo&&!selection.persistentNodes?.evidenceOnly:!selection.persistentNodes?.evidenceOnly)fail('Unselected persistent-node evidence');
    paths.add(node.path);decimal(node.ownerId);decimal(node.groupId);decimal(node.mtimeNs,true);
    for(const id of [node.deviceMajor,node.deviceMinor])if(!Number.isInteger(id)||id<0||id>4294967295)fail('Invalid source device evidence');
  }
  if(total>maximumBytes)fail('Selected filesystem metadata exceeds 16 MiB');
  for(const name of paths)if(name!=='.'&&name.split('/').slice(0,-1).some((_,index)=>metadata.persistentNodes.some(node=>node.path===name.split('/').slice(0,index+1).join('/'))))fail('Persistent nodes cannot be parent directories');
}
function acceptedEvidence(evidence:ExtendedMetadataEvidence):void{
  if(!evidence.supported||evidence.inventoryState!=='complete-visible'||evidence.attributes.some(attribute=>attribute.state!=='value')||![evidence.accessAcl,evidence.defaultAcl].every(acl=>acl.state==='value'||acl.state==='absent'))fail('Selected metadata is unsupported, unreadable or incomplete; source retained');
}
export async function captureFilesystemMetadata(root:string,selection:ReviewedUserDataSelection,rootMappings?:ReadonlyMap<string,string>,capture?:GitExportCapture,capturedInventory?:WorkingFolderInventory):Promise<PortableFilesystemMetadata>{
  const provenance=await filesystemMetadataProvenance(),inventory=capturedInventory??await inventoryWorkingFolder(root,selection,capture,rootMappings);
  const result:PortableFilesystemMetadata={version:1,sourceQualifier:provenance.qualifier,allNamespacesComplete:false,nodes:[],persistentNodes:[]};
  if(selection.extendedMetadata){
    for(const [relativePath,kind] of [['.','directory'],...inventory.directories.map(item=>[item.path,'directory']),...inventory.paths.map(item=>[item,'file'])] as Array<[string,'file'|'directory']>){
      const target=relativePath==='.'?root:path.join(root,relativePath);
      if(await fs.realpath(target)!==target)fail('Selected metadata node is no longer canonical');
      const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|(kind==='directory'?constants.O_DIRECTORY:0));
      await withMetadataHandle(handle,async()=>{
        const stat=await handle.stat({bigint:true}),evidence=inspectExtendedMetadata({fd:handle.fd,expectedDevice:stat.dev,expectedInode:stat.ino,kind,sourceQualifier:provenance.qualifier,...(kind==='file'?{expectedLinkCount:inventory.linkCounts.get(relativePath)??1n}:{})});
        acceptedEvidence(evidence);
        const userAttributes=selection.extendedMetadata.userXattrs?evidence.attributes.filter(attribute=>attribute.name.subarray(0,5).equals(Buffer.from('user.'))).map(attribute=>({nameBase64:attribute.name.toString('base64'),valueBase64:attribute.value!.toString('base64')})):[];
        result.nodes.push({path:relativePath,kind,mode:evidence.identity.mode,mtimeNs:String(evidence.identity.mtimeNs),ownerId:String(evidence.identity.ownerId),groupId:String(evidence.identity.groupId),userAttributes,
          accessAclBase64:selection.extendedMetadata.posixAcl&&evidence.accessAcl.state==='value'?evidence.accessAcl.value!.toString('base64'):null,
          defaultAclBase64:selection.extendedMetadata.posixAcl&&evidence.defaultAcl.state==='value'?evidence.defaultAcl.value!.toString('base64'):null});
      });
    }
  }
  for(const relativePath of inventory.persistentPaths){
    const target=path.join(root,relativePath),parent=path.dirname(target);
    if(await fs.realpath(parent)!==parent)fail('Persistent-node parent changed');
    const handle=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    await withMetadataHandle(handle,async()=>{
      const stat=await handle.stat({bigint:true}),node=inspectPersistentNode({parentFd:handle.fd,expectedParentDevice:stat.dev,expectedParentInode:stat.ino,leaf:path.basename(target)});
      result.persistentNodes.push({path:relativePath,kind:node.kind,mode:node.mode,mtimeNs:String(node.mtimeNs),ownerId:String(node.ownerId),groupId:String(node.groupId),deviceMajor:node.deviceMajor,deviceMinor:node.deviceMinor});
    });
  }
  validateFilesystemMetadata(result,selection);
  return result;
}
export function planFilesystemMetadata(metadata:PortableFilesystemMetadata,selection:ReviewedUserDataSelection,activation:ReviewedMetadataActivation):void{
  validateFilesystemMetadata(metadata,selection);
  if(metadata.sourceQualifier!==activation.sourceQualifier)fail('Metadata source provenance differs from the reviewed original');
  if(selection.extendedMetadata&&(!selection.extendedMetadata.userXattrs||!selection.extendedMetadata.posixAcl))fail('Applying native metadata requires both complete user attributes and POSIX ACL selection');
  if(metadata.persistentNodes.some(node=>node.kind!=='fifo'))fail('Socket/device evidence is preserved; recreation requires its actual service or device mapping');
  if(metadata.persistentNodes.length&&!activation.fifo)fail('Explicit FIFO recreation choice required');
  for(const node of metadata.nodes){
    for(const encoded of [node.accessAclBase64,node.defaultAclBase64]){
      if(encoded===null)continue;
      const acl=bytes(encoded);
      if(acl.length<4||(acl.length-4)%8||acl.readUInt32LE(0)!==2)fail('Unsupported POSIX ACL evidence');
      for(let offset=4;offset<acl.length;offset+=8){
        const tag=acl.readUInt16LE(offset),kind=tag===2?'user':tag===8?'group':undefined;
        if(kind&&!activation.principalMappings.some(mapping=>mapping.kind===kind&&mapping.sourceId===String(acl.readUInt32LE(offset+4))))fail('Missing explicit named ACL principal mapping');
      }
    }
  }
  for(const node of [...metadata.nodes,...metadata.persistentNodes]){
    for(const [kind,id] of [['user',node.ownerId],['group',node.groupId]] as const)
      if(!activation.principalMappings.some(mapping=>mapping.kind===kind&&mapping.sourceId===id&&mapping.sourceQualifier===metadata.sourceQualifier))fail('Missing explicit source owner/group mapping');
  }
}
/** Fresh import root only. Every mutation is one attempt; partial nodes remain for recovery. */
export async function applyFilesystemMetadata(root:string,metadata:PortableFilesystemMetadata,selection:ReviewedUserDataSelection,activation:ReviewedMetadataActivation,links:readonly PortableWorkingLinkDto[]=[],expectedLinkCounts?:ReadonlyMap<string,bigint>):Promise<void>{
  planFilesystemMetadata(metadata,selection,activation);
  const provenance=await filesystemMetadataProvenance();
  if(provenance.qualifier!==activation.destinationQualifier)fail('Destination metadata provenance changed; review the current host');
  const map=(kind:'user'|'group',id:string)=>Number(activation.principalMappings.find(mapping=>mapping.kind===kind&&mapping.sourceId===id)!.destinationId);
  for(const node of metadata.persistentNodes){
    if(map('user',node.ownerId)!==Number(provenance.ownerId))fail('FIFO destination owner must match the explicit mapping; ownership is never changed');
    const target=path.join(root,node.path),parent=path.dirname(target);
    if(await fs.realpath(parent)!==parent)fail('Persistent destination parent changed');
    const handle=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    await withMetadataHandle(handle,async()=>{
      const stat=await handle.stat({bigint:true}),expectedGroup=(stat.mode&0o2000n)!==0n?Number(stat.gid):Number(provenance.groupId);
      if(map('group',node.groupId)!==expectedGroup)fail('FIFO inherited group differs from the explicit mapping; no node created');
      const observed=createPersistentNode({parentFd:handle.fd,expectedParentDevice:stat.dev,expectedParentInode:stat.ino,leaf:path.basename(target),kind:'fifo',mode:node.mode,mtimeNs:BigInt(node.mtimeNs)});
      if(observed.ownerId!==map('user',node.ownerId)||observed.groupId!==map('group',node.groupId))throw Object.assign(new Error('Created FIFO ownership differs; preserve the node and review the partial result'),{code:'ERR_PORTABLE_METADATA_PARTIAL',partialStatePossible:true,observed});
    },true);
  }
  for(const node of [...metadata.nodes].sort((a,b)=>b.path.split('/').length-a.path.split('/').length||(a.path==='.'?1:b.path==='.'?-1:0))){
    const target=node.path==='.'?root:path.join(root,node.path);
    if(await fs.realpath(target)!==target)fail('Metadata destination node changed');
    const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|(node.kind==='directory'?constants.O_DIRECTORY:0));
    await withMetadataHandle(handle,async()=>{
      const stat=await handle.stat({bigint:true});
      const held={fd:handle.fd,expectedDevice:stat.dev,expectedInode:stat.ino,kind:node.kind,...(node.kind==='file'?{expectedLinkCount:expectedLinkCounts?.get(node.path)??BigInt(1+links.filter(link=>link.kind==='hardlink'&&!link.targetRootRef&&link.target===node.path).length)}:{})};
      applyExtendedMetadata({...held,restore:'replace-user-and-posix-acl',sourceQualifier:metadata.sourceQualifier,destinationQualifier:provenance.qualifier,
        sourceOwnerId:Number(node.ownerId),sourceGroupId:Number(node.groupId),destinationOwnerId:map('user',node.ownerId),destinationGroupId:map('group',node.groupId),
        principalMappings:activation.principalMappings.map(mapping=>({...mapping,sourceId:Number(mapping.sourceId),destinationId:Number(mapping.destinationId)})),
        attributes:node.userAttributes.map(attribute=>({name:bytes(attribute.nameBase64),value:bytes(attribute.valueBase64)})),
        accessAcl:node.accessAclBase64===null?null:bytes(node.accessAclBase64),defaultAcl:node.defaultAclBase64===null?null:bytes(node.defaultAclBase64),mode:node.mode});
      applyExactFileMetadata({...held,mode:node.mode,mtimeNs:BigInt(node.mtimeNs)});
    },true);
  }
}
