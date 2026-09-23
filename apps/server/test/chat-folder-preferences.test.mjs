import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { WorkspaceStore } from "@ponderosa/agents";
import { registerWorkspacePreferenceRoutes } from "../dist/routes/workspace-preferences.js";
test("chat folders validate, conflict safely, persist, and leave Project folders untouched", async () => {
  const dataDir=mkdtempSync(join(tmpdir(),"ponderosa-chat-folder-")),app=Fastify();
  try {
    const workspace=new WorkspaceStore(dataDir);
    const projectFolders=[{id:"p",name:"Projects",projectIds:["P1","P2"],expanded:true}];
    workspace.updatePreferences({projectFolders});
    registerWorkspacePreferenceRoutes(app,{opts:{dataDir},workspace,store:{getConversation:id=>["A","B"].includes(id)?{id}:undefined},engines:new Map(),publishWorkspaceSince(){}});
    const folder={id:"f",name:"Chats",conversationIds:["A"],expanded:true};
    const send=(chatFolders,chatFoldersRevision=workspace.getPreferences().revision)=>app.inject({method:"PATCH",url:"/api/workspace/preferences",payload:{chatFolders,chatFoldersRevision}});
    assert.equal((await send([folder])).statusCode,200);
    const stale=workspace.getPreferences().revision;
    const concurrent=[{...folder,conversationIds:["A","B"]}];
    assert.equal((await send(concurrent)).statusCode,200);
    assert.equal((await send([],stale)).statusCode,409);
    for(const invalid of [null,{},[null],[{...folder,name:""}],[{...folder,conversationIds:["A","A"]}],[folder,{...folder,id:"g"}],[{...folder,expanded:"yes"}]]) {
      assert.equal((await send(invalid)).statusCode,400);
      assert.deepEqual(workspace.getPreferences().chatFolders,concurrent);
    }
    const reloaded=new WorkspaceStore(dataDir);
    assert.deepEqual(reloaded.getPreferences().chatFolders,concurrent);
    assert.deepEqual(reloaded.getPreferences().projectFolders,projectFolders);
    assert.equal(workspace.getPreferences().chatFoldersRevision,undefined);
    assert.equal((await send([{...folder,conversationIds:["deleted"]}])).statusCode,400);
    assert.equal((await send([])).statusCode,200);
  } finally { await app.close();rmSync(dataDir,{recursive:true,force:true}); }
});
