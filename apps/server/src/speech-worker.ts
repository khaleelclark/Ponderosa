import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SPEECH_LIMITS, type SpeechVoiceId } from "@ponderosa/core";
import { speechLaunch } from "./speech-launch.js";

const HANDSHAKE = "1|sherpa-onnx-1.13.8|kokoro-1.0|24000";
/** One in-flight request per exact process. Abort tears down, then awaits exit. */
export class SpeechWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { ready: boolean; pcm: Buffer[]; bytes: number; resolve(value: Buffer): void; reject(error: Error): void };
  private buffer = Buffer.alloc(0);
  private stopping?: Promise<void>;
  private exited?: Promise<void>;
  constructor(private readonly executable: string, private readonly modelRoot: string, readonly voice: SpeechVoiceId) {}
  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.child || this.stopping) throw new Error("speech worker busy");
    const launch = speechLaunch(this.executable, this.modelRoot, this.voice);
    const child = spawn(launch.command, launch.args, {
      shell: false, windowsHide: true,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    // Never log native stderr: phonemizers may echo input text.
    child.stderr.resume();
    child.stdin.on("error", () => this.fail("speech input pipe closed"));
    child.on("error", () => this.fail("speech runtime could not start"));
    child.on("exit", () => { if(this.child===child){this.child=undefined;this.fail("speech runtime exited");} });
    child.stdout.on("data", (data: Buffer) => this.receive(data));
    await this.wait(true, SPEECH_LIMITS.startupTimeoutMs, signal);
  }
  private fail(reason: string): void {
    const pending = this.pending; this.pending = undefined;
    pending?.reject(new Error(reason));
  }
  private receive(data: Buffer): void {
    if (this.buffer.length + data.length > SPEECH_LIMITS.outputBytes + 5) { this.fail("speech output limit exceeded"); void this.stop(); return; }
    this.buffer = Buffer.concat([this.buffer,data]);
    while(this.buffer.length>=5){
      const kind=this.buffer[0], size=this.buffer.readUInt32LE(1);
      if(size>SPEECH_LIMITS.outputBytes){this.fail("invalid speech frame");void this.stop();return;}
      if(this.buffer.length<5+size)return;
      const frame=this.buffer.subarray(5,5+size);this.buffer=this.buffer.subarray(5+size);
      const pending=this.pending;
      if(!pending){this.fail("unexpected speech output");void this.stop();return;}
      if(pending.ready && kind===1 && frame.toString()===HANDSHAKE){this.pending=undefined;pending.resolve(Buffer.alloc(0));}
      else if(!pending.ready&&kind===2&&size%2===0&&pending.bytes+size<=SPEECH_LIMITS.outputBytes){pending.pcm.push(Buffer.from(frame));pending.bytes+=size;}
      else if(!pending.ready&&kind===3&&size===0&&pending.bytes>0){this.pending=undefined;pending.resolve(Buffer.concat(pending.pcm));}
      else {this.fail("speech protocol failure");void this.stop();return;}
    }
  }
  private async wait(ready: boolean, timeout: number, signal?: AbortSignal): Promise<Buffer> {
    if(this.pending)throw new Error("speech worker busy");
    let timer: ReturnType<typeof setTimeout>;
    const abort=()=>{this.fail("speech cancelled");void this.stop();};
    try {
      return await new Promise<Buffer>((resolve,reject)=>{
        this.pending={ready,pcm:[],bytes:0,resolve,reject};
        timer=setTimeout(()=>{this.fail("speech timed out");void this.stop();},timeout);
        signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
      });
    } catch(error){await this.stop();throw error;}
    finally {clearTimeout(timer!);signal?.removeEventListener("abort",abort);}
  }
  async synthesize(text: string,speed: number,signal: AbortSignal): Promise<Buffer> {
    if(!this.child||this.pending||this.stopping)throw new Error("speech worker unavailable");
    const bytes=Buffer.from(text);if(!bytes.length||bytes.length>SPEECH_LIMITS.segmentBytes||text.includes("\0")||!Number.isFinite(speed)||speed<.75||speed>1.25)throw new Error("invalid speech input");
    const promise=this.wait(false,SPEECH_LIMITS.segmentTimeoutMs,signal);
    if(!signal.aborted){const header=Buffer.alloc(6);header.writeUInt32LE(bytes.length);header.writeUInt16LE(Math.round(speed*100),4);this.child.stdin.write(Buffer.concat([header,bytes]));}
    const pcm=await promise;
    const wav=Buffer.alloc(44);wav.write("RIFF");wav.writeUInt32LE(pcm.length+36,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(pcm.length,40);
    return Buffer.concat([wav,pcm]);
  }
  async stop(): Promise<void> {
    if(this.stopping)return this.stopping;
    const child=this.child;if(!child)return;
    this.fail("speech stopped");
    this.stopping=(async()=>{
      const exited=this.exited!;
      child.stdin.end();child.kill("SIGTERM");
      const hard=setTimeout(()=>child.kill("SIGKILL"),1000);
      try{await exited;}finally{clearTimeout(hard);if(this.child===child)this.child=undefined;this.buffer=Buffer.alloc(0);}
    })();
    try{await this.stopping;}finally{this.stopping=undefined;}
  }
}
