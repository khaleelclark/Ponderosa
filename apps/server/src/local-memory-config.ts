import {constants,openSync,fstatSync,readFileSync,closeSync} from "node:fs";
import path from "node:path";
import type {CreateServerOptions} from "./app-contracts.js";

type MemoryOptions=NonNullable<CreateServerOptions["localMemory"]>;
/** Operator-owned startup configuration. HTTP requests cannot enable or rebind memory. */
export function loadLocalMemoryConfiguration(filename:string|undefined):MemoryOptions|undefined{
  if(filename===undefined||!filename.trim())return undefined;
  if(!path.isAbsolute(filename))throw new Error("PONDEROSA_LOCAL_MEMORY_CONFIG must be an absolute file path");
  const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  let text:string;
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o022)||(typeof process.getuid==="function"&&stat.uid!==process.getuid()))throw new Error("Local memory configuration must be an operator-owned regular file without group/other write access");
    if(stat.size>16384)throw new Error("Local memory configuration exceeds16KiB");
    text=readFileSync(fd,"utf8");
    if(Buffer.byteLength(text)>16384)throw new Error("Local memory configuration exceeds16KiB");
  }finally{closeSync(fd);}
  const value:unknown=JSON.parse(text);
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Local memory configuration must be an object");
  const c=value as Record<string,unknown>;
  const fields=["chromaUrl","collectionPrefix","modelDir","stateDirectory","provision"];
  if(Object.keys(c).some(k=>!fields.includes(k)))throw new Error("Unsupported local memory setting; legacy journal options are not adopted");
  for(const key of fields.slice(0,4))if(typeof c[key]!=="string"||!c[key]||String(c[key]).trim()!==c[key])throw new Error("Local memory requires chromaUrl, collectionPrefix, modelDir and stateDirectory");
  const url=new URL(c.chromaUrl as string);
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error("Local memory Chroma URL must be HTTP(S) without embedded credentials, query or fragment");
  if(!path.isAbsolute(c.modelDir as string)||!path.isAbsolute(c.stateDirectory as string))throw new Error("Local memory modelDir and stateDirectory must be absolute paths");
  if(c.provision!==undefined&&typeof c.provision!=="boolean")throw new Error("Local memory provision must be an explicit boolean");
  return {chromaUrl:c.chromaUrl as string,collectionPrefix:c.collectionPrefix as string,modelDir:c.modelDir as string,stateDirectory:c.stateDirectory as string,...(c.provision===undefined?{}:{provision:c.provision})};
}
