import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { WorkspaceStore } from "@ponderosa/agents";
import { registerWorkspacePreferenceRoutes } from "../dist/routes/workspace-preferences.js";
test("folder preferences reject malformed or duplicate membership without changing saved groups", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ponderosa-folder-api-"));
  const app = Fastify();
  try {
    const workspace = new WorkspaceStore(dataDir);
    registerWorkspacePreferenceRoutes(app, { opts: { dataDir }, workspace, engines: new Map(), publishWorkspaceSince() {} });
    const valid = [{ id: "work", name: "Work", projectIds: ["a", "b"], expanded: true }];
    const send = (projectFolders, projectFoldersRevision=workspace.getPreferences().revision) => app.inject({ method: "PATCH", url: "/api/workspace/preferences", payload: { projectFolders, projectFoldersRevision } });
    assert.equal((await send(valid)).statusCode, 200);
    const stale = workspace.getPreferences().revision;
    const withMember = [{...valid[0],projectIds:["a","b","c"]}];
    assert.equal((await send(withMember)).statusCode,200);
    assert.equal((await send([{...valid[0],expanded:false}],stale)).statusCode,409);
    assert.deepEqual(workspace.getPreferences().projectFolders,withMember);
    assert.equal((await send(valid)).statusCode,200);
    for (const invalid of [null, {}, [null], [{...valid[0], name:""}], [{...valid[0], projectIds:["a","a"]}], [...valid,{...valid[0],id:"other"}], [{...valid[0],expanded:"yes"}]]) {
      assert.equal((await send(invalid)).statusCode,400);
      assert.deepEqual(workspace.getPreferences().projectFolders,valid);
    }
    assert.equal((await send([])).statusCode,200);
    assert.deepEqual(workspace.getPreferences().projectFolders,[]);
  } finally { await app.close(); rmSync(dataDir,{recursive:true,force:true}); }
});
