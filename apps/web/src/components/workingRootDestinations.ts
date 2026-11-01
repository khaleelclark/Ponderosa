/** UI guidance only; canonical parent/symlink/existence checks remain server-owned. */
export function validWorkingRootDestinations(refs:string[],destinations:Record<string,string>):boolean {
 const paths=refs.map(ref=>destinations[ref]?.trim());
 if(paths.some(path=>!path||!path.startsWith('/')||path==='/'||path.split('/').some(part=>part==='.'||part==='..')))return false;
 const normalized=paths.map(path=>path!.replace(/\/+$/,'').replace(/\/+/g,'/'));
 return normalized.every((path,index)=>path.length>0&&normalized.every((other,otherIndex)=>index===otherIndex||(path!==other&&!path.startsWith(other+'/')&&!other.startsWith(path+'/'))));
}
