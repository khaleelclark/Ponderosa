import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProcess } from "../dist/json-rpc-process.js";
import { mapCodexAppServerNotification } from "../dist/codex-app-server.js";

// Inert host fixtures only. No provider binary, account or model is used.
const fixture = `
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', () => {
 const mode = process.argv[2];
 if(mode === 'record') process.stdout.write('x'.repeat(4*1024*1024+1));
 if(mode === 'aggregate') process.stdout.write('x'.repeat(1025));
 if(mode === 'queue') process.stdout.write([0,1,2].map(i =>
  JSON.stringify({method:'fixture/notice',params:{i}})+'\\n').join(''));
});
`;

for (const [mode, limits, reason] of [
  // No opt-in bounds: this is the default production Codex transport limit.
  ["record", {}, /JSONL record exceeded the 4 MiB limit/],
  ["aggregate", {maxOutputBytes:1024}, /JSON-RPC output exceeded the aggregate limit/],
  ["queue", {maxQueuedNotifications:2}, /notification queue limit exceeded/],
]) {
  for (const action of ["abort", "close"]) {
    test(`${mode} failure survives synchronous root callback ${action}`, async t => {
      const cwd = await mkdtemp(join(tmpdir(), "json-rpc-failure-"));
      const script = join(cwd, "fixture.mjs");
      await writeFile(script, fixture);
      const controller = new AbortController();
      let handle, callbackClose, reportFailure;
      const exits = [];
      const failed = new Promise(resolve => { reportFailure = resolve; });
      const deadline = setTimeout(() => controller.abort(), 5_000);
      const rpc = new JsonRpcProcess({
        bin:process.execPath, args:[script,mode], cwd,
        signal:controller.signal, killGraceMs:100, ...limits,
        onRuntimeSpawned:value => { handle = value; },
        onRuntimeRootExit:detail => {
          exits.push(detail);
          // Matches the first persistent Codex Run's synchronous host abort,
          // or an owner directly closing the registered process handle.
          if (action === "abort") controller.abort();
          else callbackClose = handle.close();
          reportFailure();
        },
      });
      t.after(async () => {
        clearTimeout(deadline);
        await handle.close();
        assert.equal(handle.isAlive(), false, "observed owned process group exit");
        await rm(cwd, {recursive:true,force:true});
      });
      assert.equal(handle, rpc, "same registered cleanup owner");
      const pending = rpc.request("initialize").catch(error => error);
      // Consume only after failure so the queue case actually fills its cap.
      await Promise.race([failed, pending]);
      const rejection = await pending;
      const notices = [];
      for await (const notice of rpc.notifications) notices.push(notice);
      await callbackClose;
      await handle.close();
      t.diagnostic(JSON.stringify({mode,action,rejection:rejection.message,notices,
        rootCallbacks:exits.length,alive:handle.isAlive()}));
      assert.equal(handle.isAlive(), false, "cleanup observes exit, not just a signal");
      assert.equal(exits.length, 1, "failure and later OS exit report exactly once");
      assert.match(rejection.message, reason, "pending request preserves the cause");
      const errors = notices.filter(notice => notice.method === "ponderosa/processError");
      assert.equal(errors.length, 1, "one terminal error survives reentrant close");
      assert.equal(errors[0].params.message, rejection.message);
      assert.equal(notices.at(-1), errors[0], "error is terminal");
      assert.deepEqual(mapCodexAppServerNotification(errors[0], cwd),
        [{type:"error",message:rejection.message}], "the production Codex consumer retains the cause");
      if (mode === "queue") {
        assert.equal(notices.length, 2, "terminal error stays within the queue cap");
        assert.deepEqual(notices[0], {method:"fixture/notice",params:{i:0}});
      } else assert.equal(notices.length, 1);
      await assert.rejects(rpc.request("late"), /closed/, "protocol work stays revoked");
      assert.deepEqual(await rpc.notifications[Symbol.asyncIterator]().next(), {value:undefined,done:true});
    });
  }
}

for (const action of ["none", "abort", "close"]) {
  test(`spawn failure survives synchronous root callback ${action}`, {
    skip: process.platform === "win32" ? "requires a POSIX executable with a missing interpreter" : false,
    timeout: 10_000,
  }, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "json-rpc-spawn-failure-"));
    const bin = join(cwd, "executable-with-missing-interpreter");
    // Pass the contained-spawn executable-file preflight; fail at the OS spawn.
    await writeFile(bin, `#!${join(cwd, "absent-interpreter")}\n`, {mode:0o700});
    const controller = new AbortController();
    let handle, callbackClose, spawnError, callbackState;
    const exits = [];
    const deadline = setTimeout(() => controller.abort(), 5_000);
    t.after(async () => {
      clearTimeout(deadline);
      await handle?.close();
      if (handle) assert.equal(handle.isAlive(), false, "same registered owner observes no live process");
      await rm(cwd, {recursive:true,force:true});
    });
    const rpc = new JsonRpcProcess({
      bin, args:[], cwd, signal:controller.signal, killGraceMs:100,
      onRuntimeSpawned:value => { handle = value; },
      onRuntimeRootExit:detail => {
        exits.push(detail);
        callbackState = {closed:handle.closed,pending:handle.pending.size};
        if (action === "abort") controller.abort();
        if (action === "close") callbackClose = handle.close();
      },
    });
    assert.equal(handle, rpc, "ownership registered before readiness");
    rpc.child.once("error", error => { spawnError = error; });
    const childClosed = new Promise(resolve => rpc.child.once("close", resolve));
    const pending = [rpc.request("initialize"), rpc.request("also-pending")]
      .map(request => request.catch(error => error));
    const rejections = await Promise.all(pending);
    const notices = [];
    for await (const notice of rpc.notifications) notices.push(notice);
    await callbackClose;
    await handle.close();
    await childClosed;
    t.diagnostic(JSON.stringify({action,rejections:rejections.map(error => error.message),
      notices,rootCallbacks:exits.length,callbackState,spawnCode:spawnError?.code,
      identity:handle.processIdentity ?? null,pid:rpc.child.pid ?? null,alive:handle.isAlive()}));
    assert.equal(spawnError.code, "ENOENT", "actual post-preflight OS spawn failure");
    const reason = `failed to spawn ${bin}: ${spawnError.message}`;
    for (const rejection of rejections) {
      assert.equal(rejection.message, reason, "pending request preserves the exact spawn cause");
    }
    assert.deepEqual(notices, [{method:"ponderosa/processError",params:{message:reason}}],
      "one matching terminal error survives reentrant close");
    assert.deepEqual(mapCodexAppServerNotification(notices[0], cwd), [{type:"error",message:reason}]);
    assert.deepEqual(callbackState, {closed:true,pending:0}, "work revoked before the root callback");
    assert.equal(exits.length, 1);
    assert.equal(exits[0], undefined, "spawn failure has no observed OS exit code or signal");
    assert.equal(rpc.child.pid, undefined, "failed spawn creates no PID");
    assert.equal(handle.processIdentity, undefined, "no invented process identity");
    assert.equal(handle.isAlive(), false);
    let lateWrites = 0;
    const write = rpc.child.stdin.write.bind(rpc.child.stdin);
    rpc.child.stdin.write = (...args) => { lateWrites++; return write(...args); };
    await assert.rejects(rpc.request("late"), /closed/);
    rpc.notify("late-notice");
    assert.equal(lateWrites, 0, "late request and notification do not write");
    assert.deepEqual(await rpc.notifications[Symbol.asyncIterator]().next(), {value:undefined,done:true});
  });
}
