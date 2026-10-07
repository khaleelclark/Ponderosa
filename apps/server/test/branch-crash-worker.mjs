import { AgentStore, BranchStore, CoordinationV3Store } from '@ponderosa/agents';
import { BranchScriptService } from '../dist/branch-script-service.js';
const store=new AgentStore(process.argv[2]);
const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
const service=new BranchScriptService(branches,store,'crashed-worker',{maxConcurrentScripts:Number(process.argv[3]??4)});
await service.tick(true);
process.send({launched:true});
setInterval(()=>{},1000);
