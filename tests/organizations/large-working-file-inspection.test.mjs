import test from 'node:test';
import assert from 'node:assert/strict';
import {LargeWorkingFileInspector} from '../../apps/server/dist/large-working-file-inspection.js';
import {validateWorkingFileData} from '../../apps/server/dist/portable-working-files.js';

const inspect=(path,bytes,step=3)=>{
 const scanner=new LargeWorkingFileInspector(path,bytes.length);
 for(let i=0;i<bytes.length;i+=step)scanner.write(bytes.subarray(i,i+step));
 scanner.finish();
};
const compare=(path,bytes)=>{
 let before,after;
 try{validateWorkingFileData(path,bytes);}catch(error){before=error;}
 try{inspect(path,bytes);}catch(error){after=error;}
 assert.equal(Boolean(after),Boolean(before),'inspection decision differs for '+path);
};

test('large-file inspector preserves existing whole-file checks across chunk boundaries',()=>{
 for(const [path,data] of [
  ['file.txt',Buffer.from('plain human text')],
  ['file.json',Buffer.from(' {"safe":[1,{"label":"value"}]} ')],
  ['file.txt',Buffer.from('{"safe":"ok","api_key":"example-only"}')],
  ['file.txt',Buffer.from('{"outer":"{\\"token\\":\\"example-only\\"}"}')],
  ['file.json',Buffer.from('{"a":1,"\\u0061":2}')],
  ['file.json',Buffer.from('{invalid')],
  ['file.txt',Buffer.from('{invalid')],
  ['file.txt',Buffer.from('prefix-----BEGIN RSA PRIVATE KEY-----suffix')],
  ['file.txt',Buffer.from([0,123,34,116,111,107,101,110,34,58,49,125])],
  ['file.txt',Buffer.from([0xff,123,34,116,111,107,101,110,34,58,49,125])],
  ['file.json',Buffer.from([0xff])],
  ['file.txt',Buffer.from('\uFFFD{"token":1}')],
  ['file.json',Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{"safe":1}')])],
 ])compare(path,data);
 const split=Buffer.from('prefix-----BEGIN PRIVATE KEY-----suffix');
 assert.throws(()=>inspect('file.bin',split,2),/Private key content/);
 const incomplete=new LargeWorkingFileInspector('file.txt',5);incomplete.write(Buffer.from('a'));assert.throws(()=>incomplete.finish(),/length differs/);
});

test('large-file inspector handles a logical original beyond 64 MiB and rejects later secrets',()=>{
 const block=Buffer.alloc(1024*1024,0x20),count=65;
 const jsonPrefix=Buffer.from('{"payload":"'),jsonSuffix=Buffer.from('","safe":true}');
 const scanner=new LargeWorkingFileInspector('large.json',jsonPrefix.length+block.length*count+jsonSuffix.length);
 scanner.write(jsonPrefix);for(let i=0;i<count;i++)scanner.write(block);scanner.write(jsonSuffix);scanner.finish();
 const secret=Buffer.from('","api_key":"example-only"}');
 const rejected=new LargeWorkingFileInspector('large.json',jsonPrefix.length+block.length*count+secret.length);
 rejected.write(jsonPrefix);for(let i=0;i<count;i++)rejected.write(block);rejected.write(secret);
 assert.throws(()=>rejected.finish(),/known credential fields/);
});


test('large-file inspector does not miss a private key marker split at 32 MiB',()=>{
 const block=Buffer.alloc(32*1024*1024,0);
 Buffer.from('-----BEG').copy(block,block.length-8);
 const rest=Buffer.from('IN PRIVATE KEY-----');
 const scanner=new LargeWorkingFileInspector('large.bin',block.length*2+rest.length);
 scanner.write(block);
 assert.throws(()=>scanner.write(rest),/Private key content/);
});

test('large-file structured inspection checks available memory before allocation',()=>{
 const original=Object.getOwnPropertyDescriptor(process,'availableMemory');
 try{
  Object.defineProperty(process,'availableMemory',{value:()=>1,configurable:true});
  assert.throws(()=>new LargeWorkingFileInspector('large.json',65*1024*1024),error=>error.statusCode===503&&/available memory/.test(error.message));
 }finally{if(original)Object.defineProperty(process,'availableMemory',original);}
});


test('large JSON inspection refuses before parsing when the V8 heap is too small',async()=>{
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync(process.execPath,['--max-old-space-size=256','--input-type=module','--import','./tests/shared/workspace-resolution.mjs','-e',`
  import {LargeWorkingFileInspector} from './apps/server/dist/large-working-file-inspection.js';
  try{new LargeWorkingFileInspector('large.json',65*1024*1024);process.exitCode=2;}
  catch(error){if(error.statusCode!==503||!String(error.message).includes('V8 heap'))process.exitCode=3;}
 `],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
