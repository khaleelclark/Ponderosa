import path from 'node:path';
import {randomUUID} from 'node:crypto';
import fs from '@ponderosa/native-host/fs';
import {beginSourceMutation} from '@ponderosa/agents';

/** A failed/unknown remote write stays ineligible across restart until explicit reconciliation. */
export function memorySourceMutations(directory:string){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error('Memory source hold directory must be private');
  if(process.platform!=='win32'){const parent=fs.openSync(path.dirname(directory),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
  const sync=()=>{if(process.platform!=='win32'){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}};
  return {
    assertSettled(){
      if(fs.readdirSync(directory).some(name=>name.endsWith('.json')))throw new Error('Checkpoint capture refused: memory mutation requires reconciliation');
    },
    async run<T>(work:()=>Promise<T>):Promise<T>{
      const finish=beginSourceMutation(),id=randomUUID(),file=path.join(directory,`${id}.json`);let settled=false;
      try{
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        const fd=fs.openSync(file,'wx',0o600);
        try{fs.writeFileSync(fd,JSON.stringify({version:1,id,state:'remote_write_unsettled'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync();
        const result=await work();
        fs.unlinkSync(file);sync();settled=true;return result;
      }finally{finish(settled?undefined:`memory-source-mutation:${id}`);}
    },
  };
}
