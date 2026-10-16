import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const install = process.env.PONDEROSA_TEST_INSTALL_ROOT;
const serverDirectory = install ? path.join(install, "app/server") : path.join(repository, "apps/server");
const require = createRequire(path.join(serverDirectory, "package.json"));
const { createServer } = await import(pathToFileURL(path.join(serverDirectory, "dist/app.js")));
const { AgentStore } = require("@ponderosa/agents");
const Database = require("better-sqlite3");

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ponderosa-deletion-restart-")));
  const dataDir = path.join(root, "data");
  const adapter = {
    id: "codex", displayName: "Controlled deletion fixture", trustedSystemPromptChannel: "developer",
    listModels: () => [{id:"fixture-model",label:"Fixture model"}], listEfforts: () => [{id:"medium",label:"Medium"}],
    defaultModel: () => "fixture-model", defaultEffort: () => "medium",
    capabilities: async () => ({steering:false,persistentSessions:false,commands:[],mcpServers:[],composerCapabilities:[]}),
    async *seed() { throw new Error("This fixture must not execute provider work"); },
    async *continue() { throw new Error("This fixture must not execute provider work"); },
  };
  const options = { dataDir, logger:false, allowedBrowseRoots:[root],
    engines:[{adapter,authStatus:async()=>({authenticated:true,source:"subscription_presence",detail:"Controlled fixture; no real-provider coverage"}),availabilityProbe:async()=>({available:true})}],
    webDist:install ? path.join(install,"app/web/dist") : path.join(repository,"apps/web/dist") };
  return {root,dataDir,options,app:undefined,
    async open() { this.app=createServer(options); await this.app.ready(); return this.app; },
    async close() { if(this.app){this.app.prepareForShutdown();await this.app.close();this.app=undefined;} },
    async dispose(passed, t) { await this.close();if(passed)rmSync(this.root,{recursive:true,force:true});else t.diagnostic(`Failed deletion fixture retained: ${this.root}`); } };
}
async function request(app,method,url,payload,headers={}) {
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload}),headers});
  return {status:response.statusCode,body:response.json()};
}
async function createChat(f,label) {
  const r=await request(f.app,"POST","/api/chats",{label,defaultEngine:"codex"},{"idempotency-key":randomUUID()});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
}
const chatFile=(f,chat)=>path.join(f.dataDir,"projects",chat.projectId,"conversations",chat.id,"conversation.json");
const projectFile=(f,chat)=>path.join(f.dataDir,"projects",chat.projectId,"project.json");
const digest=p=>createHash("sha256").update(readFileSync(p)).digest("hex");

for(const mode of ["clean shutdown","projection recovery","root relocation"]) {
  test(`completed Chat deletion reopens normally (${mode})`,async t=>{
    const f=fixture();let passed=false;
    try {
      await f.open();
      const removed=await createChat(f,"Deleted owner"), survivor=await createChat(f,"Surviving Chat");
      const workingDirectory=realpathSync(removed.workingDirectory);
      assert.equal(workingDirectory.startsWith(f.root+path.sep),true);
      let workingFile=path.join(workingDirectory,"preserved-work.txt");
      writeFileSync(workingFile,"User working output remains");
      let output=path.join(f.dataDir,"projects",removed.projectId,"preserved-output.txt");
      writeFileSync(output,"Retained Project output remains");
      const deleted=await request(f.app,"DELETE",`/api/conversations/${removed.id}`,{expectedAgentIds:[]});
      assert.equal(deleted.status,200,JSON.stringify(deleted.body));assert.equal(deleted.body.deleted,true);
      assert.equal(existsSync(chatFile(f,removed)),false);
      const retainedProjectHash=digest(projectFile(f,removed));
      await f.close();
      if(mode==="projection recovery")rmSync(path.join(f.dataDir,".projection-clean-shutdown.json"),{force:true});
      if(mode==="root relocation") {
        const old=f.root;renameSync(old,old+"-moved");
        f.root=old+"-moved";f.dataDir=path.join(f.root,"data");
        f.options.dataDir=f.dataDir;f.options.allowedBrowseRoots=[f.root];
        workingFile=workingFile.replace(old,f.root);output=output.replace(old,f.root);
      }
      for(let i=0;i<2;i++) {
        await f.open();
        const ready=await request(f.app,"GET","/api/ready");
        assert.equal(ready.status,200,JSON.stringify(ready.body));assert.equal(ready.body.status,"ready");
        assert.equal((await request(f.app,"GET",`/api/conversations/${removed.id}`)).status,404);
        const live=await request(f.app,"GET",`/api/conversations/${survivor.id}`);
        assert.equal(live.status,200);assert.equal(live.body.conversation.title,"Surviving Chat");
        assert.equal(live.body.conversation.workingDirectory.startsWith(f.root+path.sep),true);
        assert.equal(existsSync(chatFile(f,removed)),false);
        assert.equal(digest(projectFile(f,removed)),retainedProjectHash);
        assert.equal(readFileSync(workingFile,"utf8"),"User working output remains");
        assert.equal(readFileSync(output,"utf8"),"Retained Project output remains");
        await f.close();
      }
      passed=true;
    } finally {await f.dispose(passed,t);}
  });
}

test("committed deletion still reopens while storage/server cleanup remains pending",async t=>{
  const f=fixture();let store;let passed=false;
  try {
    await f.open();const chat=await createChat(f,"Committed pending cleanup");await f.close();
    store=new AgentStore(f.dataDir);
    const receipt=store.commitConversationDeletion(chat.id);
    assert.equal(receipt.canonicalDeletionCompleted,true);
    assert.equal(receipt.storageCleanupCompleted,false);
    const tombstone=path.join(f.dataDir,"projects",chat.projectId,"conversations",receipt.tombstoneName);
    assert.equal(existsSync(tombstone),true);
    store.close();store=undefined;
    store=new AgentStore(f.dataDir);
    assert.equal(store.getConversation(chat.id),undefined);
    assert.equal(store.listPendingConversationDeletionReceipts().some(r=>r.conversationId===chat.id),true);
    assert.equal(existsSync(tombstone),true);
    store.finishConversationDeletionStorageCleanup(store.getConversationDeletionReceipt(chat.id));
    store.markConversationDeletionServerCleanupComplete(chat.id);
    store.close();store=undefined;
    await f.open();assert.equal((await request(f.app,"GET",`/api/conversations/${chat.id}`)).status,404);
    passed=true;
  } finally {store?.close();await f.dispose(passed,t);}
});

test("missing live Chat metadata without a committed deletion still fails closed",async t=>{
  const f=fixture();let passed=false;
  try {
    await f.open();const chat=await createChat(f,"Unexpected missing live Chat");await f.close();
    rmSync(chatFile(f,chat));
    // Native retained storage reports a different message from Node fs.
    // The invariant is startup refusal after live metadata disappears.
    assert.throws(()=>createServer(f.options), "Missing live Chat metadata must refuse startup");
    passed=true;
  } finally {await f.dispose(passed,t);}
});

test("a deletion receipt for a different Project cannot bypass owner validation",async t=>{
  const f=fixture();let passed=false;
  try {
    await f.open();const chat=await createChat(f,"Mismatched receipt");
    const r=await request(f.app,"DELETE",`/api/conversations/${chat.id}`,{expectedAgentIds:[]});assert.equal(r.body.deleted,true);
    await f.close();
    const db=new Database(path.join(f.dataDir,"ponderosa.db"));
    try {db.prepare("UPDATE conversation_deletion_receipts SET project_id=? WHERE conversation_id=?").run(randomUUID(),chat.id);}
    finally {db.close();}
    assert.throws(()=>createServer(f.options),/Chat deletion receipt belongs to a different Project|ENOENT.*conversation\.json/);
    passed=true;
  } finally {await f.dispose(passed,t);}
});
