import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';

test('installation compensation restores the exact reserved handle and runtime settings without resurrecting a deleted Agent',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-compensation-'));let store=new AgentStore(root),passed=false;
 t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const project=store.createProject({label:'Compensation',hostPath:root,defaultEngine:'codex'});
 const before=store.createAgent(project.id,{title:'Original',engine:'codex',conversationId:project.lastConversationId,model:'original-model',effort:'medium',speed:'fast'});
 const snapshot={title:before.title,handle:before.handle,activeEngine:before.activeEngine,model:before.model??null,effort:before.effort??null,speed:before.speed??null,managementPermissions:before.managementPermissions};
 const changed=store.updateAgent(before.id,{title:'Replacement',activeEngine:'claude',model:'replacement-model',effort:'high',speed:null});
 assert.notEqual(changed.handle,before.handle);
 assert.throws(()=>store.restoreAgentConfiguration(before.id,{...snapshot,handle:'Unowned'}),/no longer owned/);
 assert.equal(store.getAgent(before.id).title,'Replacement');
 store.restoreAgentConfiguration(before.id,snapshot);
 store.close();store=new AgentStore(root);
 const restored=store.getAgent(before.id);
 for(const key of ['id','title','handle','activeEngine','model','effort','speed','managementPermissions'])assert.deepEqual(restored[key],before[key],key);
 assert.equal(store.deleteAgent(before.id),true);
 assert.equal(store.restoreAgentConfiguration(before.id,snapshot),undefined);
 assert.equal(store.getAgent(before.id),undefined);passed=true;
});
