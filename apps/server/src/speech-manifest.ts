import { LINUX_SPEECH_MANIFEST } from "./speech-linux-manifest.js";
/** Release-owned optional artifacts, never configurable from the browser. */
export interface SpeechArtifactManifest {
  version: string;
  platform: string;
  qualified: boolean;
  executable: string;
  modelRoot: string;
  /** Private distributions are staged by the deployment operator, not fetched with app credentials. */
  packageUrl?: string;
  files: Array<{ path: string; url?: string; bytes: number; sha256: string; executable?: boolean }>;
}
/** Filled only by reviewed, signed optional-runtime release publication. */
export const SPEECH_ARTIFACT_MANIFESTS: readonly SpeechArtifactManifest[] = [LINUX_SPEECH_MANIFEST];

export function validateSpeechManifest(manifest: SpeechArtifactManifest): void {
  if(!["linux-x64","darwin-arm64","win32-x64"].includes(manifest.platform)||typeof manifest.qualified!=="boolean"||!/^[a-zA-Z0-9._-]{1,80}$/u.test(manifest.version)||manifest.files.length===0||manifest.files.length>2000)throw new Error("invalid speech manifest");
  const paths=new Set<string>();
  const safe=(p:string)=>typeof p==="string"&&/^[a-zA-Z0-9_! ./-]+$/u.test(p)&&!p.startsWith("/")&&!p.split("/").some(s=>!s||s.trim()!==s||s==="."||s===".."||s.endsWith(".")||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(s));
  const validUrl=(value:string)=>{const url=new URL(value);return url.protocol==="https:"&&url.hostname==="github.com"&&!url.port&&url.pathname.startsWith("/khaleelclark/Ponderosa/releases/download/")&&!url.pathname.includes("/latest/")&&!url.username&&!url.password&&!url.search&&!url.hash;};
  if(manifest.packageUrl&&!validUrl(manifest.packageUrl))throw new Error("invalid speech package source");
  let bytes=0;
  for(const file of manifest.files){
    const normalized=file.path.toLowerCase();
    if(!safe(file.path)||paths.has(normalized)||[...paths].some(p=>p.startsWith(normalized+"/")||normalized.startsWith(p+"/"))||!/^[a-f0-9]{64}$/u.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<=0||file.bytes>600*1024*1024||(file.url?!validUrl(file.url):!manifest.packageUrl))throw new Error("invalid speech artifact");
    paths.add(normalized);bytes+=file.bytes;
  }
  if(bytes>1024*1024*1024||!manifest.files.some(f=>f.path===manifest.executable&&f.executable)||!safe(manifest.modelRoot))throw new Error("invalid speech manifest limits");
}
