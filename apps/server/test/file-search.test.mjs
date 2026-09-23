import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchWorkspaceFiles } from "../dist/file-search.js";
import Fastify from "fastify";
import { registerSearchRoutes } from "../dist/routes/search.js";
test("file search route validates query bounds and exposes a working empty search", async () => {
  const app=Fastify();
  registerSearchRoutes(app,{store:{listProjects:()=>[]},globalChatSearch:()=>({}),workspace:{},coordinationV3:{}});
  try {
    for(const url of ["/api/search/files?limit=0","/api/search/files?limit=51","/api/search/files?limit=oops",`/api/search/files?q=${"x".repeat(201)}`])assert.equal((await app.inject({url})).statusCode,400);
    const response=await app.inject({url:"/api/search/files?q=report"});
    assert.equal(response.statusCode,200);
    assert.deepEqual(response.json(),{results:[],truncated:false,unavailableRoots:0});
  } finally { await app.close(); }
});
test("file discovery matches names/paths, bounds results, excludes credentials and never follows symlinks", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"ponderosa-search-"));
  try {
    await mkdir(path.join(root,"workspace/docs"),{recursive:true});
    await mkdir(path.join(root,"outside"));
    await mkdir(path.join(root,"workspace/node_modules"));
    for(const file of ["workspace/docs/report.txt","workspace/docs/Report two.md","workspace/.report","workspace/report-token.txt","workspace/node_modules/report.js","outside/report-private.txt"])await writeFile(path.join(root,file),"private content");
    await symlink(path.join(root,"outside"),path.join(root,"workspace/linked"));
    await symlink(path.join(root,"outside/report-private.txt"),path.join(root,"workspace/report-link.txt"));
    const projects=[{id:"p",label:"Workspace",hostPath:path.join(root,"workspace")}];
    const result=await searchWorkspaceFiles(projects,"REPORT");
    assert.deepEqual(result.results.map(x=>x.path).sort(),["docs/Report two.md","docs/report.txt"].sort());
    assert.equal(result.truncated,false);
    assert.equal((await searchWorkspaceFiles(projects,"docs report",1)).truncated,true);
    assert.deepEqual((await searchWorkspaceFiles(projects,"private content")).results,[]);
    await utimes(path.join(root,"workspace/docs/report.txt"),new Date("2026-01-01"),new Date("2026-01-01"));
    await utimes(path.join(root,"workspace/docs/Report two.md"),new Date("2026-02-01"),new Date("2026-02-01"));
    const recent=await searchWorkspaceFiles(projects,"",1);
    assert.deepEqual(recent.results.map(file=>file.path),["docs/Report two.md"]);
    assert.equal(recent.truncated,true);
    const unavailable=await searchWorkspaceFiles([{...projects[0],hostPath:path.join(root,"absent")}],"report");
    assert.equal(unavailable.unavailableRoots,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});
