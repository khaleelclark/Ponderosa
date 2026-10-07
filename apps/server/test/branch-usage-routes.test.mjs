import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerUsageRoutes } from "../dist/routes/usage.js";

test("Branch provider activity routes keep all-Branches distinct from one Branch", async t => {
  const app=Fastify(),calls=[];
  t.after(()=>app.close());
  registerUsageRoutes(app,{
    store:{getProject:()=>undefined},
    tokenUsage:(scope,range)=>{calls.push({scope,range});return {scope,range};},
  });
  const all=await app.inject("/api/branches/usage?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-20T00%3A00%3A00.000Z");
  assert.equal(all.statusCode,200,all.body);
  assert.deepEqual(all.json().scope,{type:"branches"});
  const one=await app.inject("/api/branches/security-review/usage");
  assert.equal(one.statusCode,200,one.body);
  assert.deepEqual(one.json().scope,{type:"branch",id:"security-review"});
  assert.deepEqual(calls.map(call=>call.scope),[{type:"branches"},{type:"branch",id:"security-review"}]);
});
