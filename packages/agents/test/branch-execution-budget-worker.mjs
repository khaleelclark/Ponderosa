import {BranchStore,CoordinationV3Store} from '../dist/index.js';
import Database from 'better-sqlite3';
const db=new Database(process.argv[2]);db.pragma('busy_timeout=5000');
const branches=new BranchStore(db,new CoordinationV3Store(db));
if(process.argv[3]==='before-path'){
 db.function('crash_process',()=>process.kill(process.pid,'SIGKILL'));
 db.exec("CREATE TEMP TRIGGER crash_entry BEFORE INSERT ON branch_paths BEGIN SELECT crash_process(); END");
}
process.send?.('ready');
process.on('message',message=>{if(message==='go'){try{
 branches.advance('2026-01-01T00:00:00.000Z');
 if(process.argv[3]==='after-commit')process.kill(process.pid,'SIGKILL');
 process.send?.('done');db.close();process.exit(0);
 }catch(error){process.send?.({error:error.message});process.exit(1)}}});
