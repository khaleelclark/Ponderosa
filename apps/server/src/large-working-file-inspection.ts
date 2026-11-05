import {getHeapStatistics} from 'node:v8';
import {AgentPackageJsonParser, AGENT_PACKAGE_ARTIFACT_MAX_BYTES} from '@ponderosa/core';
import {isPortableSecretField, PORTABLE_SECRET_MAX_DEPTH} from './portable-secrets.js';
import {assertAgentPackageMemoryAvailable} from './agent-package-codec.js';

const privateMarkers = [
  Buffer.from('-----BEGIN PRIVATE KEY-----'),
  Buffer.from('-----BEGIN RSA PRIVATE KEY-----'),
];
const markerTail = Math.max(...privateMarkers.map(marker => marker.length)) - 1;
const invalidJson = 'Agent package must contain valid bounded JSON';

/** Inspect the full logical original, not independent segments. Callers must
 * enforce package memory admission before constructing this inspector: the
 * existing incremental parser materializes valid JSON and nested JSON strings.
 * The caller validates the working path and owns the source descriptor and its
 * before/after identity checks. */
export class LargeWorkingFileInspector {
  private readonly decoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  private readonly requiredJson:boolean;
  private parser:AgentPackageJsonParser|undefined;
  private parseError:unknown;
  private consumed=0;
  private tail=Buffer.alloc(0);
  private invalidUtf8=false;
  private hasNull=false;
  private hasReplacement=false;
  private firstText=true;
  private candidate:boolean|undefined;
  private finished=false;

  constructor(private readonly relative:string,private readonly declaredBytes:number) {
    if(typeof relative!=='string'||!relative)throw new Error('Working-file path is required');
    if(!Number.isSafeInteger(declaredBytes)||declaredBytes<0||declaredBytes>AGENT_PACKAGE_ARTIFACT_MAX_BYTES)
      throw new Error('Working-file inspection length exceeds the package limit');
    this.requiredJson=/\.json$/i.test(relative);
    // This parser materializes valid structured data. Use the same preflight
    // and available-memory reserve as package import; never bypass it.
    this.checkMemory();
    this.parser=new AgentPackageJsonParser(undefined,true,()=>this.checkMemory());
  }

  private checkMemory():void {
    if(this.declaredBytes>64*1024*1024){
      assertAgentPackageMemoryAvailable(0);
      // The retained parser materializes valid JSON in V8, whose heap limit can
      // be much smaller than process or host memory. Keep room for one maximum
      // parser token and its temporary copy before and throughout inspection.
      if(this.requiredJson||this.candidate===true){
        const heap=getHeapStatistics();
        if(heap.heap_size_limit-heap.used_heap_size<1024*1024*1024)
          throw Object.assign(new Error('Large working-file JSON inspection needs 1 GiB of available V8 heap; source data is retained'),{statusCode:503});
      }
    }
  }

  write(chunk:Buffer):void {
    if(this.finished||!Buffer.isBuffer(chunk))throw new Error('Working-file inspection input is invalid');
    this.checkMemory();
    this.consumed+=chunk.length;
    if(this.consumed>this.declaredBytes)throw new Error('Working-file inspection length differs');
    const current=this.tail.length?Buffer.concat([this.tail,chunk]):chunk;
    if(privateMarkers.some(marker=>current.includes(marker)))throw new Error('Private key content cannot be exported: '+this.relative);
    this.tail=Buffer.from(current.subarray(Math.max(0,current.length-markerTail)));
    if(chunk.includes(0))this.hasNull=true;
    if(this.invalidUtf8)return;
    try{this.acceptText(this.decoder.decode(chunk,{stream:true}));}
    catch(error){
      if(error instanceof TypeError){this.invalidUtf8=true;this.parser=undefined;}
      else throw error;
    }
  }

  private acceptText(value:string):void {
    if(!value)return;
    if(value.includes('\uFFFD'))this.hasReplacement=true;
    // Buffer.toString preserves a UTF-8 BOM, but the existing strict
    // TextDecoder used for .json strips its first BOM.
    if(this.firstText){
      this.firstText=false;
      if(this.requiredJson&&value.startsWith('\uFEFF'))value=value.slice(1);
    }
    if(!this.requiredJson&&this.candidate===undefined){
      const first=value.search(/\S/u);
      if(first>=0)this.candidate='[{"'.includes(value[first]!);
    }
    if(this.candidate===false){this.parser=undefined;return;}
    if(!this.parser)return;
    this.checkMemory();
    try{this.parser.write(value);}
    catch(error){this.parseError=error;this.parser=undefined;}
  }

  finish():void {
    if(this.finished)throw new Error('Working-file inspection is already finished');
    this.finished=true;
    if(this.consumed!==this.declaredBytes)throw new Error('Working-file inspection length differs');
    if(!this.invalidUtf8){
      try{this.acceptText(this.decoder.decode());}
      catch(error){if(error instanceof TypeError)this.invalidUtf8=true;else throw error;}
    }
    if(!this.requiredJson&&(this.invalidUtf8||this.hasNull||this.hasReplacement||this.candidate!==true))return;
    if(this.invalidUtf8)throw new Error('Selected JSON must be valid before secret-field inspection: '+this.relative);
    let parsed:unknown;
    if(this.parser){
      try{parsed=this.parser.end();}
      catch(error){this.parseError=error;}
    }
    if(this.parseError){
      if((this.parseError as Error).message!==invalidJson)throw this.parseError;
      if(this.requiredJson)throw new Error('Selected JSON must be valid before secret-field inspection: '+this.relative);
      return;
    }
    if(this.parser?.hasDuplicateKeys())throw new Error('Portable JSON contains duplicate object keys; preserve the original and resolve ambiguity before export');
    // Non-.json data is inspected as structured data only when its text starts
    // with a JSON object, array or quoted string, matching the existing rule.
    if(!this.requiredJson&&typeof parsed!=='object'&&typeof parsed!=='string')return;
    inspectStructured(parsed,this.relative,0,{checkMemory:()=>this.checkMemory(),visits:0});
  }
}

type InspectionWork={checkMemory:()=>void;visits:number};
function inspectStructured(value:unknown,relative:string,depth:number,work:InspectionWork):void {
  if((++work.visits & 65535)===0)work.checkMemory();
  if(depth>PORTABLE_SECRET_MAX_DEPTH)throw new Error('Portable structured data exceeds the supported nesting depth');
  if(typeof value==='string'){
    if(!/^[\s]*[\[{"]/.test(value))return;
    const parser=new AgentPackageJsonParser(undefined,true,work.checkMemory);
    let nested:unknown;
    try{parser.write(value);nested=parser.end();}
    catch(error){if((error as Error).message===invalidJson)return;throw error;}
    if(parser.hasDuplicateKeys())throw new Error('Portable JSON contains duplicate object keys; preserve the original and resolve ambiguity before export');
    inspectStructured(nested,relative,depth+1,work);
    return;
  }
  if(Array.isArray(value)){for(const item of value)inspectStructured(item,relative,depth+1,work);return;}
  if(value&&typeof value==='object')for(const key in value){
    if(!Object.prototype.hasOwnProperty.call(value,key))continue;
    if(isPortableSecretField(key))throw new Error('Selected working file '+relative+' cannot contain known credential fields');
    inspectStructured((value as Record<string,unknown>)[key],relative,depth+1,work);
  }
}
