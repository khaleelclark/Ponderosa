import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../../apps/server/dist/app.js";

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ponderosa-launcher-products-"));
  const options = { dataDir, logger: false, engines: [], launcherSecurity: { controlToken: "owned-launcher-control" } };
  let app = createServer(options);
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    inject: options => app.inject(options),
    reopen: async () => { await app.close(); app = createServer(options); await app.ready(); },
  };
}

test("launcher destinations keep the two UIs and reject arbitrary redirects", async t => {
  const f = await setup(t);
  const cases = [
    ["", "/"],
    ["?next=%2F", "/"],
    ["?next=%2Fbranches", "/branches"],
    ["?next=/branches", "/branches"],
    ["?next=https%3A%2F%2Fexample.com", "/"],
    ["?next=%2F%2Fexample.com", "/"],
    ["?next=javascript%3Aalert(1)", "/"],
    ["?next=%252Fbranches", "/"],
    ["?next=%2Fbranches%2Fother", "/"],
    ["?next=%2Fbranches%3Fother%3D1", "/"],
    ["?next=%2Fbranches%23fragment", "/"],
    ["?next=%20%2Fbranches", "/"],
    ["?next=%5C%5Cexample.com", "/"],
    ["?next=", "/"],
  ];
  for (const [query, destination] of cases) await t.test(query || "CLI launch without next", async () => {
    const page=await f.inject({method:"GET",url:"/__ponderosa_bootstrap"+query});assert.equal(page.statusCode,200);assert.equal(page.headers["set-cookie"],undefined);
    const script=await f.inject({method:"GET",url:"/__ponderosa_bootstrap.js"});assert.equal(script.statusCode,200);
    const redirects=[];await vm.runInNewContext(script.body,{URLSearchParams,navigator:{},location:{search:query,replace:target=>redirects.push(target)}});
    assert.deepEqual(redirects,[destination]);
  });
});

test("both products work without browser credentials before and after restart", async t => {
  const f = await setup(t);
  for(let pass=0;pass<2;pass++){
    for(const url of ["/api/projects","/api/branches"]){const reply=await f.inject({method:"GET",url});assert.equal(reply.statusCode,200);assert.deepEqual(reply.json(),[]);}
    if(pass===0)await f.reopen();
  }
});

test('credential-free launch still checks the installed worker before navigating',async t=>{
 const f=await setup(t),script=await f.inject({method:'GET',url:'/__ponderosa_bootstrap.js'}),events=[];
 await vm.runInNewContext(script.body,{URLSearchParams,navigator:{serviceWorker:{async getRegistration(){events.push('registration');return {async update(){events.push('update');}};}}},location:{search:'?next=/branches',replace:target=>events.push(target)}});
 assert.deepEqual(events,['registration','update','/branches']);
});
