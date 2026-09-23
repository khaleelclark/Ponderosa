// Run only against an offline disposable full-state copy; never starts a server/provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AgentStore } from "../dist/index.js";
const root=process.argv[2];
if(!root?.startsWith("/tmp/ponderosa-chat-rehearsal-")) throw new Error("Disposable rehearsal path required");
function journalHashes(dir,out=new Map()) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const file=join(dir,entry.name);
    if(entry.isDirectory()) journalHashes(file,out);
    else if(entry.isFile() && entry.name.endsWith(".jsonl")) out.set(file,createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  return out;
}
const db=new Database(join(root,"ponderosa.db"),{readonly:true});
const counts=Object.fromEntries(["conversations","agents","coordination_requests","managed_artifact_projection"].map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
db.close();
const journals=journalHashes(join(root,"projects"));
for(let pass=0;pass<2;pass++) {
  const store=new AgentStore(root);
  try {
    for(const [table,n] of Object.entries(counts)) assert.equal(store.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,n,table);
    let chats=0;
    for(const project of store.listProjects()) for(const chat of store.listConversations(project.id)) {
      assert.equal(chat.workingDirectory,project.hostPath);
      assert.equal(typeof chat.instructions,"string"); chats++;
    }
    assert.equal(chats,counts.conversations);
  } finally {store.close();}
  assert.deepEqual(journalHashes(join(root,"projects")),journals,"Canonical history must not change");
}
console.log("PASS offline migration and second-start idempotency",JSON.stringify(counts),"unchanged journals",journals.size);
