import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServerSession} from '../../../packages/engines/dist/codex-app-server.js';

test('Codex runtime defaults enabled app tools to unattended use without enabling tools or widening host authority',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-tool-policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bin=join(dir,'provider.mjs'),record=join(dir,'received.json');
 await writeFile(bin,`#!/usr/bin/env node
import readline from 'node:readline';import fs from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume'){fs.writeFileSync(process.env.TEST_RECORD,JSON.stringify({args:process.argv.slice(2),params:m.params}));send({id:m.id,result:{thread:{id:'thread'}}});}
});`,{mode:0o755});
 for(const resumeSessionId of [undefined,'thread']){
  const runtime=await CodexAppServerSession.open({bin,cwd:dir,sandboxMode:'workspace-write',history:[],resumeSessionId,signal:new AbortController().signal,environment:{TEST_RECORD:record},onRuntimeSpawned(){},onRuntimeRootExit(){}});
  try{const received=JSON.parse(await readFile(record,'utf8'));assert.ok(received.args.includes('apps._default.default_tools_approval_mode="approve"'));assert.equal(received.params.approvalPolicy,'never');assert.equal(received.params.sandbox,'workspace-write');assert.equal(received.args.some(a=>a.includes('enabled=')||a.includes('enabled =')),false);}finally{await runtime.close();}
 }
});
