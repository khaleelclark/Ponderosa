import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JobAuthority, spawnWindowsContainedProcess } from '../../packages/engines/dist/windows-job-process.js';
import { terminateProcessGroup } from '../../packages/engines/dist/process-termination.js';

function controlledAuthority(active = 0) {
  const state = { active, closes: 0, terminations: 0, kills: 0, queryError: false };
  const child = { exitCode: null, signalCode: null, kill() { state.kills++; } };
  const job = {
    activeProcesses() { if (state.queryError) throw new Error('Accounting unavailable'); return state.active; },
    terminate() { state.terminations++; },
    close() { state.closes++; },
  };
  return { state, child, authority: new JobAuthority(child, job) };
}

test('a verified empty assigned Job stays stopped after close before Node reports root exit', () => {
  const { state, child, authority } = controlledAuthority();
  authority.assigned();
  assert.equal(authority.isAlive(), false);
  authority.close();
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(authority.isAlive(), false, 'Closing a drained Job resurrected its liveness');
  authority.close();
  assert.equal(state.closes, 1);
  child.exitCode = 1;
  assert.equal(authority.isAlive(), false);
});

test('closing an active assigned Job does not claim its root has exited', () => {
  const { child, authority } = controlledAuthority(2);
  authority.assigned();
  authority.close();
  assert.equal(authority.isAlive(), true);
  child.signalCode = 'SIGTERM';
  assert.equal(authority.isAlive(), false);
});

test('an empty unassigned Job cannot prove a pending root has exited', () => {
  const { child, authority } = controlledAuthority();
  authority.close();
  assert.equal(authority.isAlive(), true);
  child.exitCode = 1;
  assert.equal(authority.isAlive(), false);
});

test('assignment failure retains pending-root liveness until its exit is observed', () => {
  const { state, child, authority } = controlledAuthority();
  authority.assignmentFailed();
  assert.equal(state.kills, 1);
  assert.equal(state.closes, 1);
  assert.equal(authority.isAlive(), true);
  child.exitCode = 1;
  assert.equal(authority.isAlive(), false);
});

test('termination still requires an empty Job before close can record terminal liveness', () => {
  const { state, authority } = controlledAuthority(3);
  authority.assigned();
  authority.terminate();
  assert.equal(state.terminations, 1);
  assert.equal(authority.isAlive(), true);
  state.active = 0;
  assert.equal(authority.isAlive(), false);
  authority.close();
  assert.equal(authority.isAlive(), false);
});

test('failed Job accounting leaves close retryable instead of claiming a drained tree', () => {
  const { state, authority } = controlledAuthority(2);
  authority.assigned();
  state.queryError = true;
  assert.throws(() => authority.close(), /Accounting unavailable/);
  assert.equal(state.closes, 0);
  state.queryError = false;
  assert.equal(authority.isAlive(), true);
  authority.terminate();
  assert.equal(state.terminations, 1);
  state.active = 0;
  authority.close();
  assert.equal(authority.isAlive(), false);
});

test('native Windows Job termination drains an inert root and descendant without reviving liveness',
  { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ponderosa-job-liveness-'));
    const { child, authority } = spawnWindowsContainedProcess({
      bin: process.execPath,
      args: ['-e', `const {spawn}=require('node:child_process');
        const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
        descendant.once('spawn',()=>console.log(JSON.stringify({pid:process.pid,descendantPid:descendant.pid})));
        setInterval(()=>{},1000);`],
      cwd: root, env: process.env, stdin: 'ignore',
    });
    const exited = once(child, 'exit');
    let success = false;
    t.after(async () => {
      await terminateProcessGroup(child, { label: 'owned inert liveness regression', termGraceMs: 3000 }, authority);
      await exited;
      assert.equal(authority.isAlive(), false);
      if (success) {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        await rm(root, { recursive: true, force: true });
      }
      else t.diagnostic(`Failed owned liveness fixture retained: ${root}`);
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    const deadline = Date.now() + 3000;
    while (!output.includes('\n') && Date.now() < deadline) await delay(10);
    const observed = JSON.parse(output.trim());
    assert.ok(observed.pid > 0 && observed.descendantPid > 0);
    assert.ok(authority.job.activeProcesses() >= 3, 'Root, inert runtime and descendant were not owned by the Job');
    await terminateProcessGroup(child, { label: 'owned inert liveness regression', termGraceMs: 3000 }, authority);
    assert.equal(authority.isAlive(), false, 'A drained Job became alive while Node exit callbacks were pending');
    await exited;
    assert.equal(authority.isAlive(), false);
    success = true;
    t.diagnostic(`Observed drained Job and root exit for gate ${child.pid}, runtime ${observed.pid}, descendant ${observed.descendantPid}`);
  });
