import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {workingFileArtifactRefs,WORKING_FILE_PART_MEDIA_TYPE} from '../../packages/core/dist/index.js';
import {validatePortableAgentPackage} from '../../apps/server/dist/portable-agent-package-validation.js';
import {verifyPortableWorkingFileParts} from '../../apps/server/dist/portable-working-file-parts.js';

const MiB=1024*1024;
const createdAt='2026-11-01T00:00:00.000Z';
const artifact=(ref,declared)=>({ref,kind:'document',path:'portable-working-part/'+ref,summary:'Transport part; not a complete file',createdAt,
 mediaType:WORKING_FILE_PART_MEDIA_TYPE,dataBase64:'YQ==',...(declared?{dataEncoding:'gzip',decodedSize:declared}:{})});
const pkg=()=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',exportedAt:createdAt,sourceLabel:'parts',rootRef:'agent',
 agents:[{ref:'agent',title:'Agent',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},
 workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'large.bin',artifactRef:'part-a',parts:{
 schema:'ponderosa.working-file-parts.v1',refs:['part-a','part-b'],byteLength:64*MiB+1,sha256:'0'.repeat(64)}}],
 artifacts:[artifact('part-a',64*MiB),artifact('part-b')]}]});

test('working-file parts describe one complete ordered original and retain legacy references',()=>{
 const source=pkg(),file=source.agents[0].workingFiles[0];
 assert.deepEqual(validatePortableAgentPackage(source).package,source);
 assert.deepEqual(workingFileArtifactRefs(file),['part-a','part-b']);
 assert.deepEqual(workingFileArtifactRefs({path:'ordinary',artifactRef:'old'}),['old']);
 const legacy=pkg();delete legacy.agents[0].workingFiles[0].parts;legacy.agents[0].artifacts=[{...legacy.agents[0].artifacts[0],mediaType:'application/octet-stream'}];
 assert.deepEqual(validatePortableAgentPackage(legacy).package,legacy);
});

test('working-file parts reject missing, aliased, malformed and user-visible transport references',()=>{
 const cases=[
  s=>s.agents[0].workingFiles[0].parts.refs=['part-a','part-a'],
  s=>s.agents[0].workingFiles[0].parts.refs=['part-b','part-a'],
  s=>s.agents[0].workingFiles[0].parts.refs=['part-a','absent'],
  s=>s.agents[0].workingFiles[0].parts.byteLength++,
  s=>s.agents[0].workingFiles[0].parts.byteLength=64*MiB,
  s=>s.agents[0].workingFiles[0].parts.sha256='bad',
  s=>s.agents[0].workingFiles[0].parts.extra=true,
  s=>s.agents[0].artifacts[1].mediaType='text/plain',
  s=>s.agents[0].workingFiles.push({path:'alias',artifactRef:'part-b'}),
  s=>s.agents[0].workingFiles.push({...structuredClone(s.agents[0].workingFiles[0]),path:'another-large.bin'}),
  s=>s.agents[0].workingFiles[0].parts.refs=Array(1025).fill('part-a'),
  s=>s.agents[0].workingFiles[0].parts.byteLength=4*1024*MiB+1,
  s=>s.agents[0].history=[{role:'user',text:'attachment',attachmentRefs:['part-b']}],
  s=>s.sourceProjectInstructions='Open ponderosa://artifact/part-b',
  s=>s.agents[0].initialInstructions='Open ponderosa://artifact/part-b',
  s=>delete s.agents[0].workingFiles[0].parts,
 ];
 for(const mutate of cases){const source=pkg();mutate(source);assert.throws(()=>validatePortableAgentPackage(source));}
});

test('ordered bytes are verified for the complete large original before writing',()=>{
 const first=Buffer.alloc(64*MiB,0x61),last=Buffer.from('b'),sha256=createHash('sha256').update(first).update(last).digest('hex');
 const file={path:'large.bin',artifactRef:'part-a',parts:{schema:'ponderosa.working-file-parts.v1',refs:['part-a','part-b'],byteLength:first.length+last.length,sha256}};
 assert.deepEqual(verifyPortableWorkingFileParts(file,[first,last]),{sha256,byteLength:first.length+last.length});
 assert.throws(()=>verifyPortableWorkingFileParts(file,[last,first]),/SHA-256/);
 assert.throws(()=>verifyPortableWorkingFileParts(file,[first,Buffer.from('c')]),/SHA-256/);
 assert.throws(()=>verifyPortableWorkingFileParts(file,[first]),/missing/);
 assert.equal(verifyPortableWorkingFileParts({path:'old',artifactRef:'old'},[last]).byteLength,1);
});
