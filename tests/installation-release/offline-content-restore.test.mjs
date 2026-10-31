import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {AgentStore,WorkspaceStore} from '@ponderosa/agents';
import {restoreContent} from '../../packages/agents/dist/offline-content-restore.js';

function source(t,folders) {
  const root=mkdtempSync(path.join(tmpdir(),'ponderosa-offline-folders-'));
  let passed=false;t.after(()=>{if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Failed offline fixture retained: ${root}`);});
  const store=new AgentStore(path.join(root,'source-data'));
  const projects=[];
  try {
    for(const title of ['Filed Chat','Unfiled Chat']) {
      const project=store.createProject({label:title,hostPath:root,defaultEngine:'codex'});
      projects.push({project,agents:[],conversations:store.listConversations(project.id)});
    }
  }finally{store.close();}
  const directory=path.join(root,'backup');mkdirSync(directory);
  const files=[],digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  function write(name,value,raw=false) {
    const bytes=Buffer.from(raw?value:JSON.stringify(value));const target=path.join(directory,name);
    mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes);
    files.push({path:name,bytes:bytes.length,sha256:digest(bytes)});
  }
  for(const project of projects) {
    write(`projects/${project.project.id}/project-content.json`,{...project,communicationEvents:[],communicationRevisions:[],communicationProjections:[]});
    const chat=project.conversations[0];
    write(`chats/${chat.id}/chat-archive.json`,{historyCompleteAtRead:true,originalChat:chat,detail:{conversation:chat},messages:[]});
    write(`canonical-state/projects/${project.project.id}/artifacts/artifacts.jsonl`,'',true);
  }
  const ids=projects.map(p=>p.conversations[0].id);
  write('manifest.json',{channel:'dev',projects,agentCount:0,conversationCount:2,backupScope:{retainedChatIds:ids}});
  write('folder-scope.json',{folders:folders(ids)});write('artifact-inventory.json',[]);
  const index=Buffer.from(JSON.stringify({channel:'dev',files}));writeFileSync(path.join(directory,'file-index.json'),index);
  return {output:path.join(root,'restored'),sources:[{directory,channel:'dev',indexSha256:digest(index)}],ids,complete(){passed=true;}};
}

for(const count of [0,1])test(`offline restore preserves ${count?'partly filed':'unfiled'} Chats without inventing folders or runtime`,t=>{
  const f=source(t,ids=>count?[{id:randomUUID(),name:'Existing folder',conversationIds:[ids[0]],expanded:true}]:[]);
  const receipt=restoreContent(f);assert.equal(receipt.chatCount,2);assert.equal(receipt.runtimeAuthorityRestored,false);
  const store=new AgentStore(f.output),workspace=new WorkspaceStore(f.output);
  try {
    assert.deepEqual(store.listProjects().flatMap(p=>store.listConversations(p.id).map(c=>c.id)).sort(),[...f.ids].sort());
    assert.equal(workspace.getPreferences().chatFolders.length,count);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
  }finally{workspace.close();store.close();}
  f.complete();
});

for(const invalid of ['unknown','duplicate'])test(`offline restore refuses ${invalid} folder Chat identities`,t=>{
  const f=source(t,ids=>invalid==='unknown'?[{id:randomUUID(),name:'Unknown',conversationIds:[randomUUID()]}]:[
    {id:randomUUID(),name:'One',conversationIds:[ids[0]]},{id:randomUUID(),name:'Two',conversationIds:[ids[0]]},
  ]);
  assert.throws(()=>restoreContent(f),/folder.*Chat scope/);f.complete();
});
