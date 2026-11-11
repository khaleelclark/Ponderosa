import assert from 'node:assert/strict';
import test from 'node:test';
import {CapabilityPolicyStore} from '@ponderosa/agents';
import {openCurrentMemoryDatabase} from '../../packages/agents/dist/state-admission.js';

test('permission audit and policy commit atomically, preserve existing before state, and paginate without gaps',t=>{
 const db=openCurrentMemoryDatabase();t.after(()=>db.close());const store=new CapabilityPolicyStore(db);
 const put=(revision,ids=[])=>store.put({scopeKind:'product',scopeId:'interactive',expectedRevision:revision,restrictedCapabilityIds:ids});
 // Model an existing install: do not invent historical actors or events.
 db.prepare("INSERT INTO capability_policies VALUES ('product','interactive',4,'[\"memory.read\"]','2026-01-01')").run();
 assert.deepEqual(store.history('product','interactive').changes,[]);
 put(4);assert.deepEqual(store.history('product','interactive').changes[0].before,['memory.read']);
 db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON capability_policy_history BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 assert.throws(()=>put(5,['memory.write']),/audit unavailable/);
 assert.equal(store.get('product','interactive').revision,5);assert.equal(store.history('product','interactive').changes.length,1);
 db.exec('DROP TRIGGER reject_history');
 for(let i=5;i<58;i++)put(i);
 const first=store.history('product','interactive'),second=store.history('product','interactive',first.nextBeforeRevision);
 assert.equal(first.changes.length,50);assert.equal(second.changes.length,4);assert.equal(second.nextBeforeRevision,undefined);
 assert.deepEqual([...first.changes,...second.changes].map(c=>c.revision),Array.from({length:54},(_,i)=>58-i));
 assert.ok(first.changes.every(c=>c.actor==='system'),'Internal callers cannot be mislabeled as human Settings');
});

// The optional immutable base build exercises normal admission with genuine
// predecessor-created bytes, not a head database with migration evidence erased.
const upgradeBase=process.env.PONDEROSA_UPGRADE_BASE_AGENTS;
for(const scenario of ['upgrade','rollback','unknown schema','incomplete schema','false receipt','missing receipt','generation mismatch','corrupt bytes'])test(`canonical pre-history AgentStore ${scenario}`,{skip:!upgradeBase},async t=>{
 const {mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync,rmSync,lstatSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const {pathToFileURL}=await import('node:url');const {spawnSync}=await import('node:child_process');
 const {createHash,randomUUID}=await import('node:crypto');
 const {AgentStore}=await import('@ponderosa/agents');const {default:Database}=await import('better-sqlite3');
 const root=mkdtempSync(join(tmpdir(),'history-base-upgrade-')),state=join(root,'state'),workspace=join(root,'workspace');mkdirSync(workspace);
 let passed=false;t.after(()=>{if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained upgrade evidence: ${root}`)});
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {AgentStore,CapabilityPolicyStore} from ${JSON.stringify(pathToFileURL(resolve(upgradeBase)).href)};
  const store=new AgentStore(process.argv[1]);
  try {
   if(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='capability_policy_history'").get())throw Error('Expected actual pre-history build');
   const project=store.createProject({label:'Preserved upgrade Chat',chatOwned:true,hostPath:process.argv[2],defaultEngine:'codex'});
   const policy=new CapabilityPolicyStore(store.sqlite).put({scopeKind:'product',scopeId:'interactive',expectedRevision:0,restrictedCapabilityIds:['memory.read']});
   console.log(JSON.stringify({projectId:project.id,conversationId:project.lastConversationId,policy}));
  } finally {store.close();}
 `,state,workspace],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);const seeded=JSON.parse(child.stdout);
 const marker=join(state,'.ponderosa-layout-version'),originalMarker=readFileSync(marker,'utf8');
 const hashes=()=>Object.fromEntries(readdirSync(state,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=join(e.parentPath,e.name);return[file.slice(state.length),createHash('sha256').update(readFileSync(file)).digest('hex')]}).sort(([a],[b])=>a.localeCompare(b)));
 // Only disposable test fixtures are deliberately corrupted, after base close.
 if(!['upgrade','rollback','generation mismatch','corrupt bytes'].includes(scenario)){
  const db=new Database(join(state,'ponderosa.db'));
  try {
   if(scenario==='unknown schema')db.exec('CREATE TABLE unsupported_extra(value TEXT)');
   if(scenario==='incomplete schema')db.exec('DROP TABLE capability_policies');
   if(scenario==='false receipt')db.prepare("INSERT INTO _schema_version VALUES (?,?)").run('0028_capability_policy_history.sql','synthetic');
   if(scenario==='missing receipt')db.prepare("DELETE FROM _schema_version WHERE name=?").run('0027_schedule_work_lookup.sql');
  } finally {db.close();}
 }
 if(scenario==='generation mismatch')writeFileSync(marker,JSON.stringify({...JSON.parse(originalMarker),generationId:randomUUID()})+'\n');
 if(scenario==='corrupt bytes'){const file=join(state,'ponderosa.db'),bytes=readFileSync(file);bytes[0]=0;writeFileSync(file,bytes);}
 const physical=[state,join(state,'ponderosa.db')].map(file=>{const stat=lstatSync(file);return [stat.dev,stat.ino]});
 const before=hashes();
 if(scenario==='upgrade'){
  let store=new AgentStore(state);
  try {
   const policies=new CapabilityPolicyStore(store.sqlite);
   assert.equal(store.getProject(seeded.projectId).label,'Preserved upgrade Chat');
   assert.equal(store.getConversation(seeded.conversationId).projectId,seeded.projectId);
   assert.deepEqual(policies.get('product','interactive').restrictedCapabilityIds,['memory.read']);
   assert.deepEqual(policies.history('product','interactive').changes,[],'No historical events fabricated');
   policies.put({scopeKind:'product',scopeId:'interactive',expectedRevision:1,restrictedCapabilityIds:[],actor:'operator',reason:'Upgrade proof'});
   assert.deepEqual(policies.history('product','interactive').changes[0].before,['memory.read']);
   assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM _schema_version WHERE name='0028_capability_policy_history.sql'").get().n,1);
  } finally {store.close();}
  assert.equal(readFileSync(marker,'utf8'),originalMarker,'Generation authority stays byte-identical');
  assert.deepEqual([state,join(state,'ponderosa.db')].map(file=>{const stat=lstatSync(file);return [stat.dev,stat.ino]}),physical,'No root or database replacement');
  store=new AgentStore(state);try{assert.equal(new CapabilityPolicyStore(store.sqlite).history('product','interactive').changes.length,1);assert.ok(store.getConversation(seeded.conversationId));}finally{store.close();}
 }else if(scenario==='rollback'){
  const original=Database.prototype.exec;let injected=false;
  Database.prototype.exec=function(sql){const result=original.call(this,sql);if(this.name!==':memory:'&&sql.includes('CREATE TABLE capability_policy_history')){injected=true;throw Error('synthetic migration failure')}return result};
  try{assert.throws(()=>new AgentStore(state),/synthetic migration failure/);}finally{Database.prototype.exec=original;}
  assert.equal(injected,true,'Fail after live DDL, before migration receipt');assert.deepEqual(hashes(),before,'Failed migration preserves source bytes');
  const reopened=new AgentStore(state);try{assert.deepEqual(new CapabilityPolicyStore(reopened.sqlite).get('product','interactive').restrictedCapabilityIds,['memory.read']);}finally{reopened.close();}
 }else{
  assert.throws(()=>new AgentStore(state),/unsupported or incomplete current state|not a database|malformed/);
  assert.deepEqual(hashes(),before,'Refusal preserves every source file byte');
 }
 passed=true;
});
