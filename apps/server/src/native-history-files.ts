import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "@ponderosa/native-host/fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
/** Bounded preview identity, not a lock against independent host writers. */
export function nativeRewindFileFacts(root:string,paths:string[]):unknown[] {
  if(paths.length>1000||realpathSync(root)!==root)throw new Error("Canonical bounded working folder required");
  let bytes=0;
  const rows:unknown[]=[];
  for(const name of [...new Set(paths)].sort()) {
    const path=isAbsolute(name)?resolve(name):resolve(root,name),rel=relative(root,path);
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error("Native rewind path is outside this working folder");
    const ancestors:unknown[]=[];
    for(let parent=dirname(path);;parent=dirname(parent)) {
      const stat=lstatSync(parent);
      if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(parent)!==parent)throw new Error("Rewind parent identity unsafe");
      ancestors.push([parent,stat.dev,stat.ino,stat.mode,stat.uid,stat.gid]);
      if(parent===root)break;
    }
    try {
      const stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16*1024*1024)throw new Error("Rewind file identity unsafe or too large");
      bytes+=stat.size;if(bytes>64*1024*1024)throw new Error("Rewind preview exceeds byte bound");
      const hash=createHash('sha256').update(readFileSync(path)).digest('hex');
      const after=lstatSync(path);
      if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw new Error("File changed during preview");
      rows.push({path,ancestors,type:'file',dev:stat.dev,ino:stat.ino,mode:stat.mode,uid:stat.uid,gid:stat.gid,size:stat.size,hash});
    }catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      rows.push({path,ancestors,type:'absent'});
    }
  }
  return rows;
}
