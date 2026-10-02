import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonRpcProcess } from "../dist/json-rpc-process.js";
import { mapCodexAppServerNotification } from "../dist/codex-app-server.js";

const fixture = `import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
const mode=process.argv[2];
if(mode==='startup') process.exit(2);
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 emit({id:r.id,result:{}});
 if(r.method!=='fixture/turn')return;
 if(mode==='cancel')return;
 if(mode==='descendant')spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,2]});
 if(mode==='completed'||mode==='interrupted')emit({method:'turn/completed',params:{turn:{id:'exact',status:mode}}});
 setTimeout(()=>process.exit(0),10);
});`;

for (const mode of ["startup", "completed", "interrupted", "exit-zero", "cancel", "descendant"]) {
  test(`actual owned RPC process: ${mode}, terminal/exit evidence stays distinct and cleanup is observed`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "runtime-process-evidence-"));
    const script = join(directory, "fixture.mjs"); await writeFile(script, fixture);
    const controller = new AbortController(); const exits = []; let handle;
    const rpc = new JsonRpcProcess({ bin: process.execPath, args: [script, mode], cwd: directory, signal: controller.signal, killGraceMs: 100,
      onRuntimeSpawned: value => { handle = value; }, onRuntimeRootExit: detail => {
        exits.push(detail);
        if (mode === "descendant") void handle.close().catch(() => {});
      } });
    try {
      if (mode === "startup") { await assert.rejects(rpc.initialize()); assert.equal(exits.length, 1); }
      else {
        await rpc.initialize(); await rpc.request("fixture/turn", {});
        if (mode === "cancel") controller.abort();
        const events = []; for await (const notification of rpc.notifications) events.push(...mapCodexAppServerNotification(notification, directory));
        assert.equal(events.some(event => event.type === "turn_done"), mode === "completed");
        if (mode === "interrupted") assert.equal(events.some(event => event.type === "error"), true);
        if (mode === "cancel") assert.equal(exits.length, 0, "host close is not reclassified as unexpected root exit");
        else { assert.equal(exits.length, 1); assert.equal(exits[0].exitCode, 0); }
      }
      await handle.close(); assert.equal(handle.isAlive(), false, "cleanup means observed group exit, including descendant-held pipes");
    } finally { await handle.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
