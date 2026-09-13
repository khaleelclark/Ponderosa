import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SPEECH_LIMITS, SPEECH_VOICES, type SpeechStatusDto, type SynthesizeSpeechRequest, type SpeechVoiceId } from "@ponderosa/core";
import { SpeechWorker } from "./speech-worker.js";
import { SpeechAdmission } from "./speech-admission.js";
import { SPEECH_ARTIFACT_MANIFESTS, validateSpeechManifest, type SpeechArtifactManifest } from "./speech-manifest.js";

export class SpeechService {
  private state: SpeechStatusDto["kokoro"];
  private active?: string;
  private protectedDirectory?: string;
  private activeManifest?: SpeechArtifactManifest;
  private operation?: Promise<void>;
  private controller?: AbortController;
  private worker?: SpeechWorker;
  private failures=0;
  private retryAfter=0;
  private busy=false;
  private busyDone?: Promise<void>;
  private generation=0;
  private readonly admission=new SpeechAdmission();
  private closed=false;
  private readonly cache=new Map<string,{audio:Buffer;at:number}>();
  private cacheBytes=0;
  private readonly root: string;
  private readonly manifest?: SpeechArtifactManifest;
  constructor(dataDir:string,private readonly changed:()=>void,private readonly installed:()=>void,private readonly manifests:readonly SpeechArtifactManifest[]=SPEECH_ARTIFACT_MANIFESTS,private readonly observe:(event:string,fields:Record<string,number|string>)=>void=()=>{},private readonly packageDirectory:string|undefined=process.env.PONDEROSA_SPEECH_PACKAGE_DIRECTORY){
    this.root=path.join(dataDir,"local-speech");
    this.manifest=manifests.find(m=>m.platform===`${process.platform}-${process.arch}`);
    if(this.manifest)validateSpeechManifest(this.manifest);
    this.state={state:this.manifest?"not_installed":"unsupported",platformQualified:this.manifest?.qualified??false,
      packageSource:this.manifest?.packageUrl?"host_package":"download",
      reason:this.manifest?undefined:"A verified local-voice package has not been published for this host in this release.",
      downloadBytes:this.manifest?.files.reduce((n,f)=>n+f.bytes,0),estimatedInstalledBytes:this.manifest?.files.reduce((n,f)=>n+f.bytes,0)};
  }
  status():SpeechStatusDto {this.prune();return {browserFallbackAvailable:true,kokoro:{...this.state},voices:SPEECH_VOICES,cacheBytes:this.cacheBytes};}
  async notices():Promise<string>{
    if(!this.manifest)throw new Error("No optional voice package is available.");
    const files=this.manifest.files.filter(file=>file.path.startsWith("notices/"));
    if(files.reduce((sum,file)=>sum+file.bytes,0)>2*1024*1024)throw new Error("Voice notices exceed the display limit.");
    const sections:string[]=[];
    for(const file of files){
      const parts:Buffer[]=[];let bytes=0;
      for await(const part of await this.packageFile(file,AbortSignal.timeout(15000))){bytes+=part.length;if(bytes>file.bytes)throw new Error("Invalid voice notices.");parts.push(Buffer.from(part));}
      const content=Buffer.concat(parts);
      if(bytes!==file.bytes||createHash("sha256").update(content).digest("hex")!==file.sha256)throw new Error("Voice notices could not be verified.");
      sections.push(`${file.path}\n\n${content.toString("utf8")}`);
    }
    return sections.join("\n\n----------------------------------------\n\n");
  }
  private async packageFile(file:SpeechArtifactManifest["files"][number],signal:AbortSignal):Promise<AsyncIterable<Uint8Array>>{
    signal.throwIfAborted();
    if(!file.url){
      if(!this.packageDirectory)throw new Error("private package not staged");
      const root=path.join(this.packageDirectory,this.manifest!.version);
      const metadata=await fs.lstat(root);
      if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new Error("unsafe package directory");
      const target=path.join(root,`${file.sha256}-${path.basename(file.path)}`);
      const stat=await fs.lstat(target);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes)throw new Error("invalid staged package file");
      return (async function*(){const handle=await fs.open(target,"r");try{yield*handle.createReadStream({signal});}finally{await handle.close();}})();
    }
    let url=new URL(file.url);let response:Response|undefined;
    for(let redirects=0;redirects<=4;redirects++){
      if(url.protocol!=="https:"||!["github.com","release-assets.githubusercontent.com"].includes(url.hostname)||url.username||url.password)throw new Error("unapproved artifact origin");
      response=await fetch(url,{redirect:"manual",signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])});
      if(response.status>=300&&response.status<400){const location=response.headers.get("location");await response.body?.cancel();if(!location)throw new Error("invalid artifact redirect");url=new URL(location,url);continue;}break;
    }
    if(!response?.ok||!response.body)throw new Error("artifact download failed");
    return response.body;
  }
  private update(patch:Partial<SpeechStatusDto["kokoro"]>):void{const previous=this.state.state;this.state={...this.state,...patch};if(this.closed)return;if(previous!==this.state.state)this.observe("state",{state:this.state.state});this.changed();}
  private async safeRoot():Promise<void>{await fs.mkdir(this.root,{recursive:true,mode:0o700});const stat=await fs.lstat(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("unsafe speech storage");}
  private async reconcile():Promise<boolean>{
    // Only installer-owned UUID entries are eligible. Never traverse symbolic links.
    // ponytail: bound each pass to 128 root entries / 10,000 nodes / 32 levels;
    // oversized or inaccessible residue stays visible and can be retried with Repair.
    let nodes=0;
    const remove=async(target:string,depth:number):Promise<void>=>{
      if(++nodes>10_000||depth>32)throw new Error("cleanup limit");
      const stat=await fs.lstat(target);
      if(stat.isDirectory()&&!stat.isSymbolicLink()){
        const directory=await fs.opendir(target);
        for await(const entry of directory)await remove(path.join(target,entry.name),depth+1);
        await fs.rmdir(target);
      }else await fs.unlink(target);
    };
    try{
      await this.safeRoot();
      const directory=await fs.opendir(this.root);let entries=0;
      for await(const entry of directory){
        if(++entries>128)throw new Error("cleanup limit");
        if(!/^(?:version-[a-f0-9-]{36}|current-[a-f0-9-]{36}\.json)$/u.test(entry.name))continue;
        const target=path.join(this.root,entry.name);
        if(target===this.active||target===this.protectedDirectory)continue;
        await remove(target,0);
      }
      return true;
    }catch{
      this.update({state:"repair_required",progress:undefined,reason:"Leftover local-voice files could not be fully removed; their remaining size is unavailable. Repair retries cleanup before downloading, or Remove local voices frees managed storage."});
      return false;
    }
  }
  private async verify(directory:string,manifest=this.manifest!):Promise<void>{
    const directoryStat=await fs.lstat(directory);
    if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink())throw new Error("unsafe speech directory");
    for(const file of manifest.files){
      const target=path.join(directory,file.path);
      const actual=await fs.realpath(target);if(!actual.startsWith(await fs.realpath(directory)+path.sep))throw new Error("unsafe speech file");
      const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes)throw new Error("invalid speech file");
      const handle=await fs.open(target,"r");const hash=createHash("sha256");try{for await(const chunk of handle.createReadStream())hash.update(chunk);}finally{await handle.close();}
      if(hash.digest("hex")!==file.sha256)throw new Error("speech verification failed");
    }
  }
  async initialize():Promise<void>{
    if(!this.manifest)return;
    try{await this.safeRoot();}catch{this.update({state:"repair_required",reason:"Local voice storage is unavailable. Browser speech remains available."});return;}
    let serialized:string;
    try{const pointer=path.join(this.root,"current.json");const stat=await fs.lstat(pointer);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error("unsafe speech record");serialized=await fs.readFile(pointer,"utf8");}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"){
      if(!await this.reconcile())return;
      if(this.manifest.packageUrl&&!this.packageDirectory)this.update({state:"unsupported",reason:"The private Linux voice package must be staged by this host's administrator before installation."});
      return;
    }this.update({state:"repair_required",reason:"Local voice installation record is unreadable. Repair local voices."});return;}
    try{
      const record=JSON.parse(serialized);
      const installedManifest=this.manifests.find(m=>m.platform===this.manifest!.platform&&m.version===record.version);
      if(typeof record.directory!=="string"||!/^version-[a-f0-9-]{36}$/u.test(record.directory))throw new Error("incompatible speech record");
      this.protectedDirectory=path.join(this.root,record.directory);
      if(!installedManifest)throw new Error("incompatible speech record");
      validateSpeechManifest(installedManifest);
      const active=path.join(this.root,record.directory);await this.verify(active,installedManifest);await this.probe(active,installedManifest);
      this.active=active;this.activeManifest=installedManifest;this.update({state:installedManifest.version===this.manifest.version?"ready":"update_available",version:installedManifest.version,installedBytes:installedManifest.files.reduce((sum,file)=>sum+file.bytes,0),reason:undefined});
      await this.reconcile();
    }catch{this.update({state:"repair_required",reason:"Local voices need verification or repair."});}
  }
  private async probe(directory:string,manifest=this.manifest!,signal?:AbortSignal):Promise<void>{const worker=new SpeechWorker(path.join(directory,manifest.executable),path.join(directory,manifest.modelRoot),"voice_1");try{await worker.start(signal);}finally{await worker.stop();}}
  install():void{
    if(this.closed||!this.manifest)throw new Error("Local voices are unavailable on this host.");
    if(this.state.state==="removing")throw new Error("Local voices are being removed.");
    if(this.operation)return;
    if(this.state.state==="ready")return;
    this.update({state:"downloading",reason:undefined});
    this.controller=new AbortController();const controller=this.controller;
    this.operation=this.performInstall(AbortSignal.any([controller.signal,AbortSignal.timeout(20*60*1000)])).finally(()=>{this.operation=undefined;this.controller=undefined;});
  }
  private async performInstall(signal:AbortSignal):Promise<void>{
    const previous=this.active;const stage=path.join(this.root,`version-${randomUUID()}`);
    let committed=false;
    try{
      await this.safeRoot();
      if(!await this.reconcile())return;
      signal.throwIfAborted();
      const disk=await fs.statfs(this.root);
      if(disk.bavail*disk.bsize<(this.state.estimatedInstalledBytes??0)+64*1024*1024)throw new Error("insufficient speech storage");
      await fs.mkdir(stage,{mode:0o700});let completed=0;let notified=0;
      this.update({state:"downloading",reason:undefined,progress:{completedBytes:0,totalBytes:this.state.downloadBytes}});
      for(const file of this.manifest!.files){
        signal.throwIfAborted();const body=await this.packageFile(file,signal);
        const target=path.join(stage,file.path);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
        const handle=await fs.open(target,"wx",file.executable?0o700:0o600);const hash=createHash("sha256");let size=0;
        try{for await(const chunk of body){signal.throwIfAborted();size+=chunk.length;if(size>file.bytes)throw new Error("artifact size mismatch");hash.update(chunk);await handle.writeFile(chunk);completed+=chunk.length;if(Date.now()-notified>250){notified=Date.now();this.update({progress:{completedBytes:completed,totalBytes:this.state.downloadBytes}});}}await handle.sync();}finally{await handle.close();}
        if(size!==file.bytes||hash.digest("hex")!==file.sha256)throw new Error("artifact checksum mismatch");
      }
      signal.throwIfAborted();this.update({state:"verifying"});await this.verify(stage);signal.throwIfAborted();this.update({state:"installing"});await this.probe(stage,this.manifest,signal);signal.throwIfAborted();
      if(process.platform!=="win32"){
        const directories=new Set([stage]);
        for(const file of this.manifest!.files){let directory=path.dirname(path.join(stage,file.path));while(directory.startsWith(stage+path.sep)){directories.add(directory);directory=path.dirname(directory);}}
        for(const directory of [...directories].sort((a,b)=>b.length-a.length)){const handle=await fs.open(directory,"r");try{await handle.sync();}finally{await handle.close();}}
      }
      this.generation++;
      await this.worker?.stop();await this.busyDone;this.worker=undefined;
      const pointer=path.join(this.root,`current-${randomUUID()}.json`);
      const record=await fs.open(pointer,"wx",0o600);
      try{await record.writeFile(JSON.stringify({version:this.manifest!.version,directory:path.basename(stage)}));await record.sync();}finally{await record.close();}
      await fs.rename(pointer,path.join(this.root,"current.json"));
      this.active=stage;this.activeManifest=this.manifest;committed=true;
      this.protectedDirectory=stage;
      if(process.platform!=="win32"){const directory=await fs.open(this.root,"r");try{await directory.sync();}finally{await directory.close();}}
      this.failures=0;this.retryAfter=0;this.clearCache();this.update({state:"ready",version:this.manifest!.version,installedBytes:this.state.estimatedInstalledBytes,progress:undefined,reason:undefined});if(!this.closed)this.installed();
      await this.reconcile();
    }catch{
      if(committed){this.update(this.state.state==="installing"?{state:"repair_required",reason:"Activation durability could not be confirmed. Repair local voices."}:{reason:"Local voices are ready. Previous-version cleanup needs retry."});return;}
      if(!await this.reconcile())return;
      this.update({state:previous?(this.activeManifest?.version===this.manifest?.version?"ready":"update_available"):signal.aborted?"not_installed":"repair_required",progress:undefined,reason:signal.aborted?"Installation cancelled or timed out.":"Installation failed. Retry or repair local voices."});
    }
  }
  async cancelInstall():Promise<void>{this.controller?.abort();await this.operation;}
  async repair():Promise<void>{
    if(this.operation)return;
    if(this.state.state==="removing")throw new Error("Local voices are being removed.");
    if(!this.manifest)throw new Error("Local voices are unavailable.");
    this.update({state:"repair_required"});this.generation++;
    await this.worker?.stop();await this.busyDone;this.worker=undefined;this.install();
  }
  async remove():Promise<void>{
    if(this.operation)throw new Error("Cancel the current installation before removing local voices.");
    if(this.state.state==="removing")return;
    this.update({state:"removing"});
    this.generation++;
    try{await this.worker?.stop();await this.busyDone;this.worker=undefined;await this.safeRoot();await fs.rm(this.root,{recursive:true});this.active=undefined;this.protectedDirectory=undefined;this.clearCache();this.update({state:this.manifest?"not_installed":"unsupported",version:undefined,installedBytes:undefined,reason:undefined});}
    catch{this.update({state:"repair_required",reason:"Local voice removal could not finish safely."});throw new Error("Local voice removal failed.");}
  }
  clearCache():void{this.cache.clear();this.cacheBytes=0;if(!this.closed)this.changed();}
  private prune():void{for(const [key,entry]of this.cache){if(Date.now()-entry.at>SPEECH_LIMITS.cacheAgeMs){this.cache.delete(key);this.cacheBytes-=entry.audio.length;}}}
  async synthesize(input:SynthesizeSpeechRequest,signal:AbortSignal):Promise<Buffer>{
    if(input?.priority!==undefined&&input.priority!=="interactive"&&input.priority!=="prefetch")throw new Error("Invalid speech priority.");
    return this.admission.run(input?.priority??"interactive",signal,()=>this.synthesizeNow(input,signal));
  }
  private async synthesizeNow(input:SynthesizeSpeechRequest,signal:AbortSignal):Promise<Buffer>{
    signal.throwIfAborted();
    if(this.closed||!["ready","update_available"].includes(this.state.state)||!this.active||!this.manifest)throw new Error("Local voices are not ready.");
    if(Date.now()<this.retryAfter)throw new Error("Local speech is recovering. Try again shortly.");
    if(this.busy)throw new Error("Local voices are busy. Try again shortly.");
    const voice=SPEECH_VOICES.find(v=>v.id===input?.voice);
    if(!voice||input.language!==voice.language||typeof input.text!=="string"||!input.text.trim()||input.text.includes("\0")||Array.from(input.text).length>SPEECH_LIMITS.segmentCharacters||Buffer.byteLength(input.text)>SPEECH_LIMITS.segmentBytes||!Number.isFinite(input.speed)||input.speed<.75||input.speed>1.25||!/^[-a-zA-Z0-9]{1,80}$/u.test(input.segmentId))throw new Error("Invalid speech request.");
    const manifest=this.activeManifest??this.manifest;
    const text=input.text.trim();this.prune();const key=createHash("sha256").update(JSON.stringify([manifest.version,voice.id,voice.language,input.speed,text])).digest("hex");const cached=this.cache.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);this.observe("cache_hit",{bytes:cached.audio.length});return cached.audio;}
    this.busy=true;
    const generation=this.generation;
    const started=Date.now();
    let complete!:()=>void;
    this.busyDone=new Promise(resolve=>{complete=resolve;});
    try{
      if(!this.worker||this.worker.voice!==voice.id){await this.worker?.stop();this.worker=new SpeechWorker(path.join(this.active,manifest.executable),path.join(this.active,manifest.modelRoot),voice.id as SpeechVoiceId);await this.worker.start(signal);this.observe("runtime_ready",{durationMs:Date.now()-started});}
      const audio=await this.worker.synthesize(text,input.speed,signal);this.failures=0;
      this.observe("synthesis_complete",{durationMs:Date.now()-started,bytes:audio.length});
      if(!signal.aborted&&generation===this.generation){this.cache.set(key,{audio,at:Date.now()});this.cacheBytes+=audio.length;while(this.cacheBytes>SPEECH_LIMITS.cacheBytes||this.cache.size>SPEECH_LIMITS.cacheEntries){const oldest=this.cache.keys().next().value!;this.cacheBytes-=this.cache.get(oldest)!.audio.length;this.cache.delete(oldest);}}
      return audio;
    }catch{
      await this.worker?.stop();this.worker=undefined;
      this.observe(signal.aborted?"synthesis_cancelled":"synthesis_failed",{durationMs:Date.now()-started});
      if(generation===this.generation&&!signal.aborted){this.failures++;this.retryAfter=Date.now()+Math.min(4000,500*2**(this.failures-1));if(this.failures>=3)this.update({state:"repair_required",reason:"Local speech failed repeatedly. Retry or repair in Settings."});}
      throw new Error(signal.aborted?"Speech cancelled.":"Local speech failed. Use browser voice or try again.");
    }finally{this.busy=false;complete();this.busyDone=undefined;}
  }
  async close():Promise<void>{this.closed=true;this.admission.close();this.generation++;await this.cancelInstall();await this.worker?.stop();await this.busyDone;this.worker=undefined;this.clearCache();}
}
