import path from 'node:path';

/** Historical source paths only. These helpers never inspect the current filesystem. */
function windows(value:string):boolean{return /^[A-Za-z]:[\\/]/.test(value)||/^[\\/]{2}/.test(value);}
function bounded(value:string):void{
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||/[\x00-\x1f\x7f]/.test(value)||/^[\\/]{2}[?.](?:[\\/]|$)/.test(value))throw new Error('Invalid bounded historical source path');
}
/** Serialize an observed native path once, at its inert DTO boundary. */
export function normalizeSourcePath(value:string):string{
  bounded(value);
  if(windows(value)){
    const native=value.replace(/\//g,'\\');
    if(!/^[A-Za-z]:\\/.test(native)&&!/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(native))throw new Error('Windows source paths require a complete drive or UNC share');
    if(native.startsWith('\\\\')&&native.slice(2).split('\\').slice(0,2).some(part=>part==='.'||part==='..'))throw new Error('UNC source paths require a server and share name');
    const normalized=path.win32.normalize(native),root=path.win32.parse(normalized).root;
    let result=normalized;
    while(result.length>root.length&&result.endsWith('\\'))result=result.slice(0,-1);
    result=result.replace(/\\/g,'/').replace(/^([a-z]):/,(_,drive:string)=>drive.toUpperCase()+':');
    if(result.slice(/^[A-Za-z]:/.test(result)?2:0).includes(':'))throw new Error('Windows source stream/device paths are unsupported');
    return result;
  }
  if(!path.posix.isAbsolute(value)||value.includes('\\'))throw new Error('Source path must be a fully qualified POSIX, drive or UNC path');
  const result=path.posix.normalize(value);return result.length>1?result.replace(/\/+$/,''):result;
}
export const serializeSourcePath=normalizeSourcePath;
export function sourcePathAbsolute(value:string,base?:string):boolean{try{if(base!==undefined){bounded(value);return (windows(normalizeSourcePath(base))?path.win32:path.posix).isAbsolute(value);}normalizeSourcePath(value);return true;}catch{return false;}}
export function canonicalSourcePath(value:unknown):value is string{try{return typeof value==='string'&&normalizeSourcePath(value)===value;}catch{return false;}}
export function sourcePathKey(value:string):string{const normalized=normalizeSourcePath(value);return windows(normalized)?normalized.toLowerCase():normalized;}
export function sourcePathsEqual(left:string,right:string):boolean{return sourcePathKey(left)===sourcePathKey(right);}

export function resolveSourcePath(base:string,...parts:string[]):string{
  const normalized=normalizeSourcePath(base),win=windows(normalized);
  for(const value of parts){if(typeof value!=='string'||Buffer.byteLength(value)>4096||/[\x00-\x1f\x7f]/.test(value)||/^[A-Za-z]:(?![\\/])/.test(value))throw new Error('Ambiguous or invalid historical source path component');}
  if(win)for(const value of parts)if(/^[\\/]{2}/.test(value))normalizeSourcePath(value);
  if(!win&&parts.some(value=>value.includes('\\')))throw new Error('Backslash source components require Windows provenance');
  return normalizeSourcePath((win?path.win32:path.posix).resolve(normalized,...parts));
}
export function joinSourcePath(base:string,...parts:string[]):string{
  const normalized=normalizeSourcePath(base),win=windows(normalized);
  for(const value of parts)if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value)||/^[A-Za-z]:(?![\\/])/.test(value)||!win&&value.includes('\\'))throw new Error('Invalid historical source path component');
  return normalizeSourcePath((win?path.win32:path.posix).join(normalized,...parts));
}
export function dirnameSourcePath(value:string):string{const normalized=normalizeSourcePath(value);return normalizeSourcePath((windows(normalized)?path.win32:path.posix).dirname(normalized));}
export function basenameSourcePath(value:string):string{const normalized=normalizeSourcePath(value);return (windows(normalized)?path.win32:path.posix).basename(normalized);}
export function relativeSourcePath(from:string,to:string):string{
  const left=normalizeSourcePath(from),right=normalizeSourcePath(to);
  if(windows(left)!==windows(right))throw new Error('Source paths belong to different host path namespaces');
  return (windows(left)?path.win32:path.posix).relative(left,right).replace(/\\/g,'/');
}
export function sourcePathWithin(root:string,candidate:string):boolean{
  const parent=normalizeSourcePath(root),child=normalizeSourcePath(candidate);
  if(windows(parent)!==windows(child))return false;
  const relative=relativeSourcePath(parent,child);
  return !relative||relative!=='..'&&!relative.startsWith('../')&&!sourcePathAbsolute(relative);
}
