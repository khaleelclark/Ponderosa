import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpeechService } from "../dist/speech-service.js";

const executable=Buffer.concat([Buffer.from("#!/usr/bin/node\n"),await fs.readFile(new URL("./fixtures/speech-worker.mjs",import.meta.url))]);
const content={worker:executable,model:Buffer.from("fixture model")};
const manifest={version:"test-recovery",platform:`${process.platform}-${process.arch}`,qualified:false,executable:"worker",modelRoot:"model",files:Object.entries(content).map(([name,data])=>({path:name,url:`https://github.com/khaleelclark/Ponderosa/releases/download/test-recovery/${name}`,bytes:data.length,sha256:createHash("sha256").update(data).digest("hex"),executable:name==="worker"}))};
const make=root=>new SpeechService(root,()=>{},()=>{},[manifest]);
const versions=async root=>(await fs.readdir(path.join(root,"local-speech"))).filter(name=>name.startsWith("version-"));
async function crash(root,after){
  const source=`
    import { promises as fs } from 'node:fs';
    import { SpeechService } from ${JSON.stringify(new URL("../dist/speech-service.js",import.meta.url).href)};
    const content=${JSON.stringify(Object.fromEntries(Object.entries(content).map(([name,data])=>[name,data.toString("base64")])))};
    globalThis.fetch=async url=>new Response(Buffer.from(content[new URL(url).pathname.split('/').at(-1)],'base64'));
    const service=new SpeechService(${JSON.stringify(root)},()=>{},()=>{},[${JSON.stringify(manifest)}]);
    await service.initialize();
    const rename=fs.rename;
    fs.rename=async(...args)=>{if(${after})await rename(...args);process.kill(process.pid,'SIGKILL');await new Promise(()=>{});};
    await service.repair();await service.operation;
  `;
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--input-type=module","-e",source],{stdio:["ignore","ignore","pipe"]});let stderr="";
    child.stderr.on("data",chunk=>stderr+=chunk);child.on("error",reject);
    child.on("exit",(code,signal)=>{try{assert.equal(signal,"SIGKILL",stderr);resolve();}catch(error){reject(error);}});
  });
}
test("SIGKILL before/after pointer replacement recovers without version growth",{skip:process.platform!=="linux",timeout:30000},async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),"ponderosa-speech-recovery-"));let service;
  try{
    await crash(root,false);assert.equal((await versions(root)).length,1);
    service=make(root);await service.initialize();assert.equal(service.status().kokoro.state,"not_installed");assert.deepEqual(await fs.readdir(path.join(root,"local-speech")),[]);await service.close();
    for(let i=0;i<3;i++){
      await crash(root,true);
      const pointer=await fs.readFile(path.join(root,"local-speech/current.json"),"utf8");
      service=make(root);await service.initialize();assert.equal(service.status().kokoro.state,"ready");assert.equal((await versions(root)).length,1);
      assert.equal(await fs.readFile(path.join(root,"local-speech/current.json"),"utf8"),pointer);await service.close();
    }
  }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
test("cleanup failure is visible, blocks downloads, and retries; symlink targets and package media survive",async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),"ponderosa-speech-recovery-"));const speech=path.join(root,"local-speech");
  const orphan=path.join(speech,`version-${randomUUID()}`);const service=make(root);const unlink=fs.unlink;const fetch=globalThis.fetch;
  try{
    await fs.mkdir(orphan,{recursive:true});await fs.writeFile(path.join(orphan,"worker"),Buffer.alloc(1024*1024));
    const external=path.join(root,"prepared-package");await fs.mkdir(external);await fs.writeFile(path.join(external,"keep"),"untouched");
    await fs.symlink(external,path.join(speech,`version-${randomUUID()}`));
    await fs.writeFile(path.join(speech,"unowned-file"),"untouched");
    fs.unlink=async target=>{if(target===path.join(orphan,"worker"))throw Object.assign(new Error("denied"),{code:"EACCES"});return unlink(target);};
    globalThis.fetch=async()=>assert.fail("cleanup failure must block download");
    await service.initialize();assert.equal(service.status().kokoro.state,"repair_required");assert.match(service.status().kokoro.reason,/remaining size is unavailable/);
    await service.repair();await service.operation;assert.equal((await versions(root)).length>=1,true);assert.equal(service.status().kokoro.state,"repair_required");
    fs.unlink=unlink;await service.close();
    const retry=make(root);try{await retry.initialize();assert.equal(retry.status().kokoro.state,"not_installed");assert.deepEqual(await versions(root),[]);}finally{await retry.close();}
    assert.equal(await fs.readFile(path.join(external,"keep"),"utf8"),"untouched");assert.equal(await fs.readFile(path.join(speech,"unowned-file"),"utf8"),"untouched");
  }finally{fs.unlink=unlink;globalThis.fetch=fetch;await service.close();await fs.rm(root,{recursive:true,force:true});}
});
test("bounded recovery retries excess residue without touching the active version",{skip:process.platform!=="linux",timeout:15000},async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),"ponderosa-speech-recovery-"));let service;
  try{
    await crash(root,true);
    const speech=path.join(root,"local-speech");const pointer=await fs.readFile(path.join(speech,"current.json"),"utf8");
    for(let i=0;i<130;i++)await fs.mkdir(path.join(speech,`version-${randomUUID()}`));
    service=make(root);await service.initialize();assert.equal(service.status().kokoro.state,"repair_required");assert.ok(service.status().kokoro.installedBytes>0);await service.close();
    service=make(root);await service.initialize();assert.equal(service.status().kokoro.state,"ready");assert.equal((await versions(root)).length,1);
    assert.equal(await fs.readFile(path.join(speech,"current.json"),"utf8"),pointer);
  }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
