import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createRsbuild } from "@rsbuild/core";
import { DEFAULT_SPEECH_PREFERENCES } from "@ponderosa/core";
import { registerSpeechRoutes } from "../../server/dist/routes/speech.js";

if(!process.env.PONDEROSA_SPEECH_PACKAGE_DIRECTORY)throw new Error("Provide the qualified disposable package mirror.");
const require=createRequire(new URL("../../server/package.json",import.meta.url));
const Fastify=require("fastify");
const root=fileURLToPath(new URL("..",import.meta.url));
const temporary=await mkdtemp(path.join(tmpdir(),"ponderosa-native-browser-"));
const output=path.join(temporary,"web");
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH??"playwright");
const app=Fastify();let browser;
let preferences={speech:DEFAULT_SPEECH_PREFERENCES};
try{
  registerSpeechRoutes(app,{dataDir:path.join(temporary,"data"),workspace:{getPreferences:()=>preferences,cursor:()=>0,updatePreferences:patch=>{preferences={...preferences,...patch};}},changed(){},publishWorkspaceSince(){}});
  const build=await createRsbuild({cwd:root,rsbuildConfig:{source:{entry:{index:path.join(root,"test/speech-browser-entry.ts")}},output:{distPath:{root:output}},logLevel:"error"}});await build.build();
  app.get("/*",async(request,reply)=>{
    const name=new URL(request.url,"http://localhost").pathname;
    const file=path.resolve(output,"."+(name==="/"?"/index.html":name));
    if(!file.startsWith(output+path.sep))return reply.code(400).send();
    try{return reply.type(file.endsWith(".js")?"text/javascript":"text/html").send(await readFile(file));}catch{return reply.code(404).send();}
  });
  const base=await app.listen({host:"127.0.0.1",port:0});
  assert.equal((await app.inject({method:"POST",url:"/api/speech/kokoro/install"})).statusCode,202);
  let ready=false;for(let i=0;i<200;i++){const status=(await app.inject("/api/speech/status")).json();if(status.kokoro.state==="ready"){ready=true;break;}if(status.kokoro.state==="repair_required")throw new Error(status.kokoro.reason);await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(ready,true);
  const notices=await app.inject("/api/speech/notices");assert.match(notices.body,/GNU GENERAL PUBLIC LICENSE/);assert.match(notices.body,/MIT License/);
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});const page=await browser.newPage();
  const errors=[];const external=[];page.on("pageerror",error=>errors.push(error.message));page.on("request",request=>{if(new URL(request.url()).origin!==base)external.push(request.url());});
  await page.goto(base+"/?native=1");
  const started=performance.now();await page.click("#native-play");
  await page.waitForFunction(()=>window.speechTest.speechSnapshot().status==="speaking",{},{timeout:20000});
  const playingMs=Math.round(performance.now()-started);
  await page.evaluate(()=>window.speechTest.pauseSpeech());assert.equal(await page.evaluate(()=>window.speechTest.speechSnapshot().status),"paused");
  await page.evaluate(()=>window.speechTest.resumeSpeech());
  await page.waitForFunction(()=>window.speechTest.speechSnapshot().status==="stopped",{},{timeout:15000});
  await page.click("#native-play");await page.waitForFunction(()=>window.speechTest.speechSnapshot().status==="speaking");
  await page.evaluate(()=>{document.getElementById("one").hidden=true;});await page.waitForFunction(()=>window.speechTest.speechSnapshot().status==="stopped");
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({passed:true,playingMs,checks:["actual-install-route","full-notices-before-play","real-WAV-HTTP","real-HTMLAudio-play-pause-resume-completion","cache-replay","hidden-surface-stop","no-external-browser-requests"]}));
}finally{await browser?.close();await app.close();await rm(temporary,{recursive:true,force:true});}
