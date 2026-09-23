import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePreferencesWriter, rebaseFolderChange } from "../src/workspacePreferencesWriter.js";
const folder = {id:"work",name:"Work",projectIds:["A","B"],expanded:true};
const prefs = {revision:1,projectFolders:[folder]};
for (const operation of ["move", "remove", "ungroup"]) {
  test(`${operation} of last known member preserves its intent through a 409/retry`, async () => {
    const source={...folder,projectIds:["A"]};
    const destination={id:"other",name:"Other",expanded:true,projectIds:["C"]};
    let cache={revision:1,projectFolders:[source,destination]};
    let server=structuredClone(cache), attempts=0;
    const writer=new WorkspacePreferencesWriter({read:()=>cache,publish:value=>{cache=value;},refresh:async()=>structuredClone(server),write:async patch=>{
      attempts++;
      if(attempts===1) server={revision:2,projectFolders:[{...source,projectIds:["A","B"]},destination]};
      if(patch.projectFoldersRevision!==server.revision) throw {status:409};
      server={revision:server.revision+1,projectFolders:structuredClone(patch.projectFolders)};
      return structuredClone(server);
    }});
    // Member removal retains an empty source until rebasing; only Ungroup omits it.
    const after=operation==="ungroup" ? [destination] : [{...source,projectIds:[]},{...destination,projectIds:operation==="move" ? ["C","A"] : ["C"]}];
    await writer.enqueueAndWait({projectFolders:after});
    assert.equal(attempts,2);
    const expected=operation==="ungroup" ? [destination] : [{...source,projectIds:["B"]},{...destination,projectIds:operation==="move" ? ["C","A"] : ["C"]}];
    assert.deepEqual(server.projectFolders,expected);
    assert.deepEqual(cache.projectFolders,expected);
  });
}
test("empty source folders are removed after a member move when no concurrent members remain",()=>{
  const source={...folder,projectIds:["A"]};
  const destination={id:"other",name:"Other",expanded:true,projectIds:["C"]};
  assert.deepEqual(rebaseFolderChange([source,destination],[source,destination],[{...source,projectIds:[]},{...destination,projectIds:["C","A"]}]),[{...destination,projectIds:["C","A"]}]);
});
test("stale collapse rebases on concurrent membership, including a delayed stale response", async () => {
  let cache=structuredClone(prefs), server=structuredClone(prefs), attempts=0;
  const writer=new WorkspacePreferencesWriter({read:()=>cache,publish:value=>{cache=value;},refresh:async()=>structuredClone(server),write:async patch=>{
    attempts++;
    if(attempts===1) {server={...server,revision:2,projectFolders:[{...folder,projectIds:["A","B","C"]}]};throw {status:409};}
    assert.equal(patch.projectFoldersRevision,2);
    server={...server,revision:3,projectFolders:patch.projectFolders};return structuredClone(server);
  }});
  await writer.enqueueAndWait({projectFolders:[{...folder,expanded:false}]});
  assert.deepEqual(cache.projectFolders,[{...folder,projectIds:["A","B","C"],expanded:false}]);
  assert.equal(writer.projectCanonical(prefs).revision,3);
});
test("folder rebase preserves unrelated rename and collapse while moving a member",()=>{
  const before=[folder,{id:"other",name:"Other",expanded:false,projectIds:["C"]}];
  const after=[{...folder,projectIds:["A"]},{...before[1],projectIds:["C","B"]}];
  const current=[{...folder,name:"Renamed",expanded:false,projectIds:["A","B","D"]},before[1]];
  assert.deepEqual(rebaseFolderChange(current,before,after),[{...current[0],projectIds:["A","D"]},{...before[1],projectIds:["C","B"]}]);
  assert.deepEqual(rebaseFolderChange([], [folder], [{...folder,expanded:false}]),[]);
});
test("failed folder saves roll back optimistic changes and leave later changes usable",async()=>{
  let cache=structuredClone(prefs), fail=true;
  const writer=new WorkspacePreferencesWriter({read:()=>cache,publish:value=>{cache=value;},refresh:async()=>structuredClone(prefs),write:async patch=>{
    if(fail)throw new Error("network failure");return {...prefs,revision:2,projectFolders:patch.projectFolders};
  }});
  await assert.rejects(writer.enqueueAndWait({projectFolders:[{...folder,expanded:false}]}));
  assert.deepEqual(cache,prefs);
  fail=false;await writer.enqueueAndWait({projectFolders:[{...folder,name:"Saved"}]});
  assert.equal(cache.projectFolders[0].name,"Saved");
});
