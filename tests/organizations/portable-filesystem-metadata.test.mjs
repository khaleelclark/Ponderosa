import assert from 'node:assert/strict';
import test from 'node:test';
import {validateFilesystemMetadata,planFilesystemMetadata} from '../../apps/server/dist/portable-filesystem-metadata.js';
import {parseReviewedUserData} from '../../apps/server/dist/portable-reviewed-user-data.js';

const qualifier='linux:'+'a'.repeat(64);
const selection={git:false,harness:false,extendedMetadata:{userXattrs:true,posixAcl:true}};
const metadata=()=>({version:1,sourceQualifier:qualifier,allNamespacesComplete:false,nodes:[{path:'.',kind:'directory',mode:0o750,mtimeNs:'-1',ownerId:'1000',groupId:'1000',userAttributes:[{nameBase64:Buffer.from('user.note').toString('base64'),valueBase64:Buffer.from('original').toString('base64')}],accessAclBase64:null,defaultAclBase64:null}],persistentNodes:[]});
const activation=()=>({sourceQualifier:qualifier,destinationQualifier:'linux:'+'b'.repeat(64),principalMappings:[{sourceQualifier:qualifier,kind:'user',sourceId:'1000',destinationId:'2000'},{sourceQualifier:qualifier,kind:'group',sourceId:'1000',destinationId:'2000'}],replaceInheritedUserAndPosixAcl:true,rootRefs:['root'],fifo:false});

test('selected user metadata preserves exact raw values and explicit ACL absence',()=>{
  const original=metadata();
  assert.doesNotThrow(()=>validateFilesystemMetadata(original,selection));
  assert.doesNotThrow(()=>planFilesystemMetadata(original,selection,activation()));
  assert.equal(Buffer.from(original.nodes[0].userAttributes[0].valueBase64,'base64').toString(),'original');
  const manifest={version:1,activation:'inert_review_only',selection,recreationScope:{absoluteLinks:'refuse',crossRootLinks:'refuse',cyclicLinks:'passive_in_root',specialNodes:'refuse',acl:'not_inspected_preserve_source',xattrs:'not_inspected_preserve_source'},providerFiles:[],providerDirectories:[],exclusions:[],filesystemMetadata:original};
  assert.deepEqual(parseReviewedUserData(Buffer.from(JSON.stringify(manifest))).filesystemMetadata,original);
  delete manifest.filesystemMetadata;
  assert.throws(()=>parseReviewedUserData(Buffer.from(JSON.stringify(manifest))),/per-node evidence/);
});
test('source-qualified mappings and both complete native families are required before apply',()=>{
  assert.throws(()=>planFilesystemMetadata(metadata(),selection,{...activation(),principalMappings:[]}),/owner\/group mapping/);
  assert.throws(()=>planFilesystemMetadata(metadata(),selection,{...activation(),sourceQualifier:'linux:'+'c'.repeat(64)}),/provenance/);
  assert.throws(()=>planFilesystemMetadata({...metadata(),nodes:[]},{git:false,harness:false,extendedMetadata:{userXattrs:true,posixAcl:false}},activation()),/both complete/);
});
test('secret attribute names and values, duplicate nodes and invented namespace completeness refuse',()=>{
  const secret=metadata();secret.nodes[0].userAttributes[0].nameBase64=Buffer.from('user.apiKey').toString('base64');
  assert.throws(()=>validateFilesystemMetadata(secret,selection),/secret attribute/);
  const key=metadata();key.nodes[0].userAttributes[0].valueBase64=Buffer.from('-----BEGIN PRIVATE KEY-----').toString('base64');
  assert.throws(()=>validateFilesystemMetadata(key,selection),/private-key/);
  assert.throws(()=>validateFilesystemMetadata({...metadata(),allNamespacesComplete:true},selection));
  const duplicate=metadata();duplicate.nodes.push(structuredClone(duplicate.nodes[0]));
  assert.throws(()=>validateFilesystemMetadata(duplicate,selection),/node/);
});
test('named ACL principals require an explicit map even when source numeric IDs look local',()=>{
  const original=metadata(),acl=Buffer.alloc(44);acl.writeUInt32LE(2);
  for(const [index,tag,id] of [[0,1,0xffffffff],[1,2,3456],[2,4,0xffffffff],[3,16,0xffffffff],[4,32,0xffffffff]]){
    acl.writeUInt16LE(tag,4+index*8);acl.writeUInt16LE(7,6+index*8);acl.writeUInt32LE(id,8+index*8);
  }
  original.nodes[0].accessAclBase64=acl.toString('base64');
  assert.throws(()=>planFilesystemMetadata(original,selection,activation()),/named ACL principal/);
});
test('FIFO recreation and device evidence never infer an execution or device grant',()=>{
  const original={...metadata(),persistentNodes:[{path:'queue',kind:'fifo',mode:0o600,mtimeNs:'0',ownerId:'1000',groupId:'1000',deviceMajor:0,deviceMinor:0,extendedMetadata:{userAttributes:[],accessAclBase64:null,defaultAclBase64:null}}]};
  const chosen={...selection,persistentNodes:{fifo:true,evidenceOnly:false}};
  assert.throws(()=>planFilesystemMetadata(original,chosen,activation()),/FIFO recreation choice/);
  assert.doesNotThrow(()=>planFilesystemMetadata(original,chosen,{...activation(),fifo:true}));
  original.persistentNodes[0].kind='socket';delete original.persistentNodes[0].extendedMetadata;
  assert.throws(()=>planFilesystemMetadata(original,{...chosen,persistentNodes:{fifo:true,evidenceOnly:true}},{...activation(),fifo:true}),/actual service/);
});

test('Linux selected metadata round trip carries user attributes through the real package flow',{skip:process.platform!=='linux'},async()=>{
  const {mkdtemp,mkdir,writeFile,open,link,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const path=await import('node:path');const {createHash}=await import('node:crypto');
  const {applyExtendedMetadata,inspectExtendedMetadata}=await import('@ponderosa/native-host');
  const {filesystemMetadataProvenance}=await import('../../apps/server/dist/portable-filesystem-metadata.js');
  const {inventoryWorkingFolder,exportWorkingFiles,importWorkingFiles}=await import('../../apps/server/dist/portable-working-files.js');
  const provenance=await filesystemMetadataProvenance(),root=await mkdtemp(path.join(tmpdir(),'portable-metadata-native-'));
  try{
    const source=path.join(root,'source'),destination=path.join(root,'destination');await mkdir(source);await writeFile(path.join(source,'note'),'original');
    const file=await open(path.join(source,'note'),'r');
    try{
      const stat=await file.stat({bigint:true});
      applyExtendedMetadata({fd:file.fd,expectedDevice:stat.dev,expectedInode:stat.ino,kind:'file',restore:'replace-user-and-posix-acl',sourceQualifier:provenance.qualifier,destinationQualifier:provenance.qualifier,sourceOwnerId:Number(stat.uid),sourceGroupId:Number(stat.gid),destinationOwnerId:Number(stat.uid),destinationGroupId:Number(stat.gid),
        principalMappings:[{sourceQualifier:provenance.qualifier,kind:'user',sourceId:Number(stat.uid),destinationId:Number(stat.uid)},{sourceQualifier:provenance.qualifier,kind:'group',sourceId:Number(stat.gid),destinationId:Number(stat.gid)}],
        attributes:[{name:Buffer.from('user.note'),value:Buffer.from('exact metadata')}],accessAcl:null,defaultAcl:null,mode:0o4640});
    }finally{await file.close();}
    await link(path.join(source,'note'),path.join(source,'alias'));
    const inventory=await inventoryWorkingFolder(source,selection),exported=await exportWorkingFiles(source,inventory.paths,1024*1024,inventory.links,selection);
    const files=exported.files.map(file=>{const data=Buffer.from(exported.artifacts.find(artifact=>artifact.ref===file.artifactRef).dataBase64,'base64');return {...file,data,sha256:createHash('sha256').update(data).digest('hex')};});
    const chosen={...activation(),sourceQualifier:provenance.qualifier,destinationQualifier:provenance.qualifier,principalMappings:[{sourceQualifier:provenance.qualifier,kind:'user',sourceId:provenance.ownerId,destinationId:provenance.ownerId},{sourceQualifier:provenance.qualifier,kind:'group',sourceId:provenance.groupId,destinationId:provenance.groupId}]};
    await importWorkingFiles(destination,files,inventory.directories,{mode:inventory.mode,mtime:inventory.mtime},undefined,inventory.links,'passive_in_root',chosen);
    const imported=await open(path.join(destination,'note'),'r');
    try{
      const stat=await imported.stat({bigint:true}),observed=inspectExtendedMetadata({fd:imported.fd,expectedDevice:stat.dev,expectedInode:stat.ino,kind:'file',sourceQualifier:provenance.qualifier,expectedLinkCount:2n});
      assert.equal(observed.attributes.find(attribute=>attribute.name.equals(Buffer.from('user.note'))).value.toString(),'exact metadata');
      assert.equal(observed.identity.mode,0o4640);
    }finally{await imported.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Linux FIFO ACL metadata survives package export/import without a content endpoint open',{skip:process.platform!=='linux'},async()=>{
  const {mkdtemp,mkdir,open,lstat,rm}=await import('node:fs/promises');
  const {constants}=await import('node:fs');const path=await import('node:path');const {tmpdir}=await import('node:os');const {createHash}=await import('node:crypto');
  const {createPersistentNode,inspectPersistentNodeMetadata,applyPersistentNodeMetadata}=await import('@ponderosa/native-host');
  const {filesystemMetadataProvenance}=await import('../../apps/server/dist/portable-filesystem-metadata.js');
  const {inventoryWorkingFolder,exportWorkingFiles,importWorkingFiles}=await import('../../apps/server/dist/portable-working-files.js');
  const provenance=await filesystemMetadataProvenance(),root=await mkdtemp(path.join(tmpdir(),'portable-fifo-acl-')),source=path.join(root,'source'),destination=path.join(root,'destination');
  const owner=Number(provenance.ownerId),group=Number(provenance.groupId),sourceNamed=owner+10,destinationNamed=owner+20;
  const mappings=[{sourceQualifier:provenance.qualifier,kind:'user',sourceId:owner,destinationId:owner},{sourceQualifier:provenance.qualifier,kind:'group',sourceId:group,destinationId:group},{sourceQualifier:provenance.qualifier,kind:'user',sourceId:sourceNamed,destinationId:sourceNamed}];
  const acl=Buffer.alloc(44);acl.writeUInt32LE(2);
  for(const [index,tag,permissions,id] of [[0,1,6,0xffffffff],[1,2,4,sourceNamed],[2,4,2,0xffffffff],[3,16,6,0xffffffff],[4,32,0,0xffffffff]]){acl.writeUInt16LE(tag,4+index*8);acl.writeUInt16LE(permissions,6+index*8);acl.writeUInt32LE(id,8+index*8);}
  try{
    await mkdir(source);const parent=await open(source,constants.O_RDONLY|constants.O_DIRECTORY);
    try{
      const stat=await parent.stat({bigint:true}),scope={parentFd:parent.fd,expectedParentDevice:stat.dev,expectedParentInode:stat.ino,leaf:'queue'};
      const created=createPersistentNode({...scope,kind:'fifo',mode:0o660,mtimeNs:1234567890000000000n,restoreExtendedMetadata:true});
      applyPersistentNodeMetadata({...scope,expectedDevice:created.device,expectedInode:created.inode,restore:'replace-user-and-posix-acl',sourceQualifier:provenance.qualifier,destinationQualifier:provenance.qualifier,sourceOwnerId:owner,sourceGroupId:group,destinationOwnerId:owner,destinationGroupId:group,principalMappings:mappings,attributes:[],accessAcl:acl,defaultAcl:null,mode:0o660});
      assert.equal(inspectPersistentNodeMetadata({...scope,sourceQualifier:provenance.qualifier}).accessAcl.entries.find(entry=>entry.tag==='user').sourceId,sourceNamed);
    }finally{await parent.close();}
    const chosenSelection={...selection,persistentNodes:{fifo:true,evidenceOnly:false}},inventory=await inventoryWorkingFolder(source,chosenSelection),exported=await exportWorkingFiles(source,inventory.paths,1024*1024,inventory.links,chosenSelection,undefined,undefined,undefined,inventory);
    const files=exported.files.map(file=>{const data=Buffer.from(exported.artifacts.find(artifact=>artifact.ref===file.artifactRef).dataBase64,'base64');return {...file,data,sha256:createHash('sha256').update(data).digest('hex')};});
    const choice={sourceQualifier:provenance.qualifier,destinationQualifier:provenance.qualifier,principalMappings:mappings.map(mapping=>({...mapping,sourceId:String(mapping.sourceId),destinationId:String(mapping.sourceId===sourceNamed?destinationNamed:mapping.destinationId)})),replaceInheritedUserAndPosixAcl:true,rootRefs:['root'],fifo:true};
    await importWorkingFiles(destination,files,inventory.directories,{mode:inventory.mode,mtime:inventory.mtime},undefined,inventory.links,'passive_in_root',choice);
    assert.equal((await lstat(path.join(destination,'queue'))).isFIFO(),true);
    const restoredParent=await open(destination,constants.O_RDONLY|constants.O_DIRECTORY);
    try{
      const stat=await restoredParent.stat({bigint:true}),observed=inspectPersistentNodeMetadata({parentFd:restoredParent.fd,expectedParentDevice:stat.dev,expectedParentInode:stat.ino,leaf:'queue',sourceQualifier:provenance.qualifier});
      assert.equal(observed.identity.kind,'fifo');assert.equal(observed.identity.mtimeNs,1234567890000000000n);
      assert.equal(observed.accessAcl.entries.find(entry=>entry.tag==='user').sourceId,destinationNamed);
      assert.equal(observed.defaultAcl.state,'absent');
    }finally{await restoredParent.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});
