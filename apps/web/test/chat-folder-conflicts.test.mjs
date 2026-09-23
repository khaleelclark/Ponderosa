import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePreferencesWriter } from "../src/workspacePreferencesWriter.js";
for (const operation of ["move", "remove", "ungroup", "collapse"]) {
  test(`chat folder ${operation} preserves unrelated concurrent changes through conflict/retry`, async () => {
    const source={id:"f",name:"Folder",conversationIds:["A"],expanded:true};
    const other={id:"g",name:"Other",conversationIds:["C"],expanded:true};
    const projectFolders=[{id:"project-f",name:"Existing",projectIds:["P1"],expanded:false}];
    let server={revision:1,chatFolders:[source,other],projectFolders}, cache=structuredClone(server), attempts=0;
    const writer=new WorkspacePreferencesWriter({read:()=>cache,publish:value=>cache=value,refresh:async()=>structuredClone(server),write:async patch=>{
      attempts++;
      if(attempts===1)server={...server,revision:2,chatFolders:[{...source,name:"Concurrent name",conversationIds:["A","B"]},other]};
      if(patch.chatFoldersRevision!==server.revision)throw {status:409};
      assert.equal(patch.projectFolders,undefined);
      server={...server,revision:3,chatFolders:patch.chatFolders}; return structuredClone(server);
    }});
    const after=operation==="ungroup"?[other]:[
      {...source,conversationIds:operation==="collapse"?["A"]:[],expanded:operation!=="collapse"},
      {...other,conversationIds:operation==="move"?["C","A"]:["C"]},
    ];
    await writer.enqueueAndWait({chatFolders:after});
    assert.equal(attempts,2);
    assert.deepEqual(cache.chatFolders,server.chatFolders);
    assert.deepEqual(cache.projectFolders,projectFolders);
    assert.deepEqual(server.chatFolders.find(f=>f.id==="f")?.conversationIds,operation==="ungroup"?undefined:operation==="collapse"?["A","B"]:["B"]);
    if(operation!=="ungroup")assert.equal(server.chatFolders[0].name,"Concurrent name");
    if(operation==="collapse")assert.equal(server.chatFolders[0].expanded,false);
  });
}
test("chat-folder failed save restores cache and later writes still work",async()=>{
  const prefs={revision:1,chatFolders:[{id:"f",name:"Folder",conversationIds:["A"],expanded:true}]};
  let cache=structuredClone(prefs),fail=true;
  const writer=new WorkspacePreferencesWriter({read:()=>cache,publish:value=>cache=value,refresh:async()=>structuredClone(prefs),write:async patch=>{
    if(fail)throw Error("offline");return {...prefs,revision:2,chatFolders:patch.chatFolders};
  }});
  await assert.rejects(writer.enqueueAndWait({chatFolders:[]}));
  assert.deepEqual(cache,prefs);fail=false;
  await writer.enqueueAndWait({chatFolders:[]});assert.deepEqual(cache.chatFolders,[]);
});
