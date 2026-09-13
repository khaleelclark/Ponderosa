import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupSpeechStorage, listSecureDirectory } from "@ponderosa/native-host";

const exec=promisify(execFile);
test("native cleanup removes only owned residue and preserves the active directory",async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),"ponderosa-speech-native-")));
  try{
    const active=`version-${randomUUID()}`,orphan=`version-${randomUUID()}`;
    await fs.mkdir(path.join(root,active));await fs.writeFile(path.join(root,active,"keep"),"active");
    await fs.mkdir(path.join(root,orphan,"nested"),{recursive:true});await fs.writeFile(path.join(root,orphan,"nested","partial"),"orphan");
    await fs.writeFile(path.join(root,`current-${randomUUID()}.json`),"temporary");
    await fs.writeFile(path.join(root,"current.json"),"committed");
    await fs.writeFile(path.join(root,"unowned"),"keep");
    const identity=listSecureDirectory({root}).find(entry=>entry.name===active).identity;
    assert.equal(cleanupSpeechStorage(root,active,identity),true);
    assert.deepEqual((await fs.readdir(root)).sort(),[active,"current.json","unowned"].sort());
    assert.equal(await fs.readFile(path.join(root,active,"keep"),"utf8"),"active");
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("cleanup directory/ancestor replacement never follows links or deletes the active identity",{skip:process.platform!=="linux",timeout:30000},async()=>{
  const temporary=await fs.mkdtemp(path.join(tmpdir(),"ponderosa-speech-race-"));
  try{
    const library=path.join(temporary,"race.so");
    await exec("cc",["-shared","-fPIC","-o",library,fileURLToPath(new URL("./fixtures/speech-cleanup-race.c",import.meta.url)),"-ldl"]);
    for(const scenario of ["orphan","nested","ancestor-before-open","ancestor-after-open","active-before-stat","active-before-open"]){
      const testRoot=path.join(temporary,scenario);const container=path.join(testRoot,"container");const storage=path.join(container,"local-speech");
      const active=`version-${randomUUID()}`;const orphan=`version-${randomUUID()}`;
      await fs.mkdir(path.join(storage,active),{recursive:true});await fs.writeFile(path.join(storage,active,"keep.txt"),"active installation");
      await fs.mkdir(path.join(storage,orphan,"nested"),{recursive:true});await fs.writeFile(path.join(storage,orphan,"nested","partial"),"orphan");
      const external=path.join(testRoot,"external");await fs.mkdir(path.join(external,"local-speech",orphan,"nested"),{recursive:true});
      for(const target of [external,path.join(external,"local-speech",orphan),path.join(external,"local-speech",orphan,"nested")])await fs.writeFile(path.join(target,"keep.txt"),"external sentinel");
      let source=path.join(storage,orphan),leaf=orphan,target=external,boundary="open",action="link";
      if(scenario==="nested"){source=path.join(source,"nested");leaf="nested";}
      if(scenario.startsWith("ancestor")){source=container;leaf=scenario==="ancestor-before-open"?"container":"local-speech";}
      if(scenario.startsWith("active")){target=path.join(storage,active);action="move";boundary=scenario==="active-before-stat"?"stat":"open";}
      const backup=path.join(testRoot,"moved");const marker=path.join(testRoot,"triggered");
      const native=new URL("../../../packages/native-host/dist/index.js",import.meta.url).href;
      await exec(process.execPath,["--input-type=module","-e",`
        import assert from 'node:assert/strict';
        import {cleanupSpeechStorage,listSecureDirectory} from ${JSON.stringify(native)};
        const identity=listSecureDirectory({root:${JSON.stringify(storage)}}).find(entry=>entry.name===${JSON.stringify(active)}).identity;
        process.env.PONDEROSA_RACE_ENABLED='1';
        cleanupSpeechStorage(${JSON.stringify(storage)},${JSON.stringify(active)},identity);
      `],{timeout:10000,env:{...process.env,LD_PRELOAD:library,PONDEROSA_RACE_LEAF:leaf,PONDEROSA_RACE_BOUNDARY:boundary,PONDEROSA_RACE_SOURCE:source,PONDEROSA_RACE_BACKUP:backup,PONDEROSA_RACE_TARGET:target,PONDEROSA_RACE_ACTION:action,PONDEROSA_RACE_MARKER:marker}});
      await fs.access(marker); // A skipped interposition must not produce a false pass.
      for(const target of [external,path.join(external,"local-speech",orphan),path.join(external,"local-speech",orphan,"nested")])assert.equal(await fs.readFile(path.join(target,"keep.txt"),"utf8"),"external sentinel",scenario);
      const activeAfter=scenario.startsWith("ancestor")?path.join(backup,"local-speech",active):scenario.startsWith("active")?source:path.join(storage,active);
      assert.equal(await fs.readFile(path.join(activeAfter,"keep.txt"),"utf8"),"active installation",scenario);
    }
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
});
