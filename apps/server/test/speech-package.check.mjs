import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpeechService } from "../dist/speech-service.js";
import { LINUX_SPEECH_MANIFEST } from "../dist/speech-linux-manifest.js";

if(!process.argv[2])throw new Error("Provide the disposable package qualification root (containing mirror/).");
const root=await realpath(process.argv[2]);
if(!root.startsWith(await realpath(tmpdir())+path.sep))throw new Error("Qualification must use a disposable temporary directory, never a deployment mirror.");
const data=await mkdtemp(path.join(root,"qualification-"));
const mirror=path.join(root,"mirror");
const events=[];
let completed=0;
let service=new SpeechService(data,()=>{},()=>{completed++;},[LINUX_SPEECH_MANIFEST],(event,fields)=>events.push({event,...fields}),mirror);
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error("Network must not be used for the private host package");};
try {
  await service.initialize();assert.equal(service.status().kokoro.state,"not_installed");
  service.install();await service.cancelInstall();assert.equal(service.status().kokoro.state,"not_installed");
  const started=performance.now();service.install();await service.operation;
  assert.equal(service.status().kokoro.state,"ready");assert.equal(completed,1);
  const installMs=Math.round(performance.now()-started);
  const input={text:"Hello. Your update is ready, and you can review it whenever you like.",voice:"voice_1",language:"en-US",speed:1,segmentId:"qualification"};
  const audio=await service.synthesize(input,new AbortController().signal);assert.ok(audio.length>44);
  const hit=performance.now();assert.deepEqual(await service.synthesize(input,new AbortController().signal),audio);const cacheMs=performance.now()-hit;
  service.clearCache();assert.equal(service.status().cacheBytes,0);
  await service.close();
  service=new SpeechService(data,()=>{},()=>{},[LINUX_SPEECH_MANIFEST],()=>{},mirror);
  await service.initialize();assert.equal(service.status().kokoro.state,"ready");
  const pointer=await readFile(path.join(data,"local-speech/current.json"),"utf8");
  const file=LINUX_SPEECH_MANIFEST.files.find(file=>file.path.endsWith("tokens.txt"));
  const mirrorFile=path.join(mirror,LINUX_SPEECH_MANIFEST.version,`${file.sha256}-${path.basename(file.path)}`);
  const original=await readFile(mirrorFile);
  try {await writeFile(mirrorFile,Buffer.alloc(original.length));await service.repair();await service.operation;
    assert.equal(service.status().kokoro.state,"ready");assert.equal(await readFile(path.join(data,"local-speech/current.json"),"utf8"),pointer);
  }finally{await writeFile(mirrorFile,original);}
  await service.remove();assert.equal(service.status().kokoro.state,"not_installed");
  service.install();await service.operation;assert.equal(service.status().kokoro.state,"ready");
  for(const [voice,language]of [["voice_1","en-US"],["voice_2","en-US"],["voice_3","en-GB"]]){
    for(const speed of [.75,1.25]){const result=await service.synthesize({...input,voice,language,speed},new AbortController().signal);assert.ok(result.length>44);}
  }
  await service.remove();
  console.log(JSON.stringify({passed:true,files:LINUX_SPEECH_MANIFEST.files.length,installMs,cacheMs,checks:["cancel-install","clean-install","offline-synthesis","cache","restart","checksum-repair-rollback","remove","reinstall","three-voices-speed-endpoints"],events:events.map(event=>event.event)}));
}finally{globalThis.fetch=originalFetch;await service.close();await rm(data,{recursive:true,force:true});}
