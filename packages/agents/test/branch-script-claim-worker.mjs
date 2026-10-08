import Database from 'better-sqlite3';
import {BranchStore,CoordinationV3Store} from '../dist/index.js';
const db=new Database(process.argv[2]);db.pragma('busy_timeout=5000');
const branches=new BranchStore(db,new CoordinationV3Store(db));
process.send('ready');
process.once('message',()=>{
 try {
  let lease;for(let i=0;i<4&&!lease;i++)lease=branches.claimScript('contender-'+process.pid);
  process.send({lease:lease??null});db.close();process.disconnect();
 }catch(error){process.send({error:error.message});db.close();process.exitCode=1;process.disconnect();}
});
