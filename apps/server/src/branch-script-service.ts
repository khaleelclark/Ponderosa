import type {BranchInstallationService} from './branch-installation-service.js';
import type { BranchResourceService } from "./branch-resource-service.js";
import type { Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { BranchStore, BranchScriptLease, AgentStore } from "@ponderosa/agents";
import { branchScriptFailureSummary, normalizeCanonicalText, unicodeCodePointLength, INLINE_TEXT_MAX_CODE_POINTS, type RuntimeProcessHandle, type WorkspaceEvent, type ReadinessDto } from "@ponderosa/core";
import { recoveredRuntimeProcessHandle, runtimeProcessHandle, spawnContainedCli } from "@ponderosa/engines";

// No user code or input is present until the parent commits process authority.
// EOF before authorization (including parent death) exits without running work.
const SCRIPT_BOOTSTRAP = `
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync(3, 'utf8');
if (createHash('sha256').update(source).digest('hex') !== process.argv[1]) process.exit(1);
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
`;

/** Supervised operations driven by the existing scheduler; no independent polling loop. */
export class BranchScriptService {
  private stopped = false;
  private readonly active = new Map<string, { handle: RuntimeProcessHandle; done: Promise<void> }>();
  constructor(private readonly branches: BranchStore, private readonly store: AgentStore, private readonly workerId: string,
    private readonly options: { notifyAction?: (input: {dedupeKey:string;branchId:string;branchExecutionId:string;projectId?:string;chatId?:string;title:string;body:string})=>string; notifyGate?: (input:{dedupeKey:string;branchId:string;branchExecutionId:string;title:string;body:string})=>void; resolveGateNotification?: (dedupeKey:string)=>void; resources?: BranchResourceService; installations?:BranchInstallationService; maxConcurrentScripts?: number; appendAudit?: (event: WorkspaceEvent) => unknown } = {}) {
    if (!Number.isSafeInteger(options.maxConcurrentScripts ?? 4) || (options.maxConcurrentScripts ?? 4) < 1) throw new Error("Invalid Script concurrency limit");
  }
  private publishAudit(): void { if (this.options.appendAudit) this.branches.publishAudit(this.options.appendAudit); }
  private reconcileGateNotifications():void{
    if(!this.options.notifyGate||!this.options.resolveGateNotification)return;
    for(const event of this.branches.gateNotificationEvents()){
      const key=`branch-gate:${event.gateId}:${event.revision}`;
      let state=event.state;
      if(state==='pending'||state==='closing_unpublished'){
        this.options.notifyGate({dedupeKey:key,branchId:event.branchId,branchExecutionId:event.executionId,title:event.purpose==='recovery'?`${event.branchName} needs a recovery decision`:`${event.branchName} needs approval`,body:`${event.prompt} (Gate revision ${event.revision})`});
        state=state==='pending'?'open':'closing';this.branches.markGateNotification(event.gateId,event.revision,state);
      }
      if(state==='closing'){
        this.options.resolveGateNotification(key);this.branches.markGateNotification(event.gateId,event.revision,'resolved');
      }
    }
  }
  async tick(admit: boolean): Promise<void> {
    await this.recoverScripts();
    this.publishAudit();
    if (this.stopped || !admit) { this.reconcileGateNotifications(); await this.options.resources?.tick(false); return; }
    void this.options.installations?.tick().catch(() => undefined);
    this.branches.advance();
    this.reconcileGateNotifications();
    await this.options.resources?.tick(admit);
    if (this.stopped) return;
    if (this.options.notifyAction) for(let index=0;index<100;index++) {
      const action=this.branches.claimAction(this.workerId);if(!action)break;
      try { const id=this.options.notifyAction({dedupeKey:`branch-action:${action.attemptId}`,branchId:action.branchId,branchExecutionId:action.executionId,projectId:action.projectId,chatId:action.chatId,title:action.title,body:action.input});this.branches.settleAction(action,id); }
      catch(error) { this.branches.actionDeliveryFailed(action,error instanceof Error?error.message:'Notification delivery remains pending'); /* Retry the same durable notification identity after lease expiry. */ }
    }
    // Host process budget; Branch admission has its own persisted policy.
    while (!this.stopped && this.active.size < (this.options.maxConcurrentScripts ?? 4)) {
      const lease = this.branches.claimScript(this.workerId);
      if (!lease) break;
      await this.launch(lease);
    }
    this.publishAudit();
  }
  private async recoverScripts(includeOwned = false): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const pending of this.branches.scriptRecoveries(this.workerId, new Date().toISOString(), includeOwned)) {
      try {
        let active = this.active.get(pending.attemptId);
        if (!active && pending.identity) {
          active = { handle: recoveredRuntimeProcessHandle(pending.identity, { label: 'Branch Script recovery', termGraceMs: 1000, killConfirmationMs: 1000 }), done: Promise.resolve() };
          this.active.set(pending.attemptId, active);
        }
        if (active) { await active.handle.close(); await active.done; }
        this.branches.recoverScript(pending.attemptId);
        this.active.delete(pending.attemptId);
      } catch (error) {
        this.branches.scriptCleanupFailed(pending.attemptId, error instanceof Error ? error.message : String(error));
        failures.push(error);
      }
    }
    return failures;
  }
  private async launch(lease: BranchScriptLease): Promise<void> {
    let handle: RuntimeProcessHandle | undefined;
    try {
      const branch = this.branches.getBranch(this.branches.execution(lease.executionId)!.branchId)!;
      const context = this.store.getChatContext(branch.chatId);
      if (branch.chatId && (!context || realpathSync(lease.cwd) !== realpathSync(context.hostPath))) throw new Error('Script directory is not the bound Chat working directory');
      if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Recoverable Branch Scripts currently require macOS or Linux');
      const { child, authority } = spawnContainedCli({ bin: process.execPath, args: ['--input-type=module', '--eval', SCRIPT_BOOTSTRAP, '--', createHash('sha256').update(lease.source).digest('hex')], cwd: lease.cwd, env: { ...process.env, NODE_OPTIONS: undefined, PONDEROSA_PARAMETERS: JSON.stringify(lease.parameters) }, stdin: 'pipe', controlPipe: true });
      handle = runtimeProcessHandle(child, { label: `Branch Script ${lease.attemptId}`, termGraceMs: 1000, killConfirmationMs: 1000 }, authority);
      const control = child.stdio[3] as Writable;
      control.on('error', () => undefined);
      child.stdin!.on('error', () => undefined);
      let output = '', stderr = '', failure: string | undefined;
      let bytes = 0;
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      const collect = (data: string, error: boolean) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 40_000) { failure = 'Script output exceeds inline limit; use managed files'; void handle!.close().catch(() => undefined); return; }
        if (error) stderr += data; else output += data;
      };
      child.stdout!.on('data', data => collect(data, false));
      child.stderr!.on('data', data => collect(data, true));
      const terminal = new Promise<{ code: number | null; error?: string }>(resolve => {
        child.once('error', error => resolve({ code: null, error: error.message }));
        child.once('exit', code => resolve({ code }));
      });
      if (!handle.processIdentity) throw new Error('Script process identity could not be recorded');
      this.branches.authorizeScript(lease, handle.processIdentity);
      const ownedHandle = handle;
      const timeout = setTimeout(() => { failure = 'Script timeout'; void ownedHandle.close().catch(() => undefined); }, lease.timeoutMs);
      const done = (async () => {
        try {
          const terminalResult = await terminal;
          await ownedHandle.close(); // Observe all descendants gone before settlement.
          // Stream data can arrive after root exit; close marks pipes drained.
          if (!child.stdout!.readableEnded || !child.stderr!.readableEnded) await new Promise<void>(resolve => child.once('close', () => resolve()));
          output = normalizeCanonicalText(output);
          stderr = normalizeCanonicalText(stderr);
          if (unicodeCodePointLength(output) > INLINE_TEXT_MAX_CODE_POINTS) failure = 'Script output exceeds inline limit; use managed files';
          const summary = branchScriptFailureSummary(terminalResult.code, failure ?? terminalResult.error);
          this.branches.recordScriptEvidence(lease, ownedHandle.processIdentity!, { stderr, stdout: output, cwd: lease.cwd, runtime: 'Node.js', finishedAt: new Date().toISOString(), outputHash: createHash('sha256').update(output).digest('hex'), code: terminalResult.code, error: summary });
          if (this.stopped) throw new Error('Script interrupted by shutdown; outcome requires reconciliation');
          this.branches.settleScript(lease, { failed: summary !== undefined, output: summary ?? output });
        } catch (error) {
          // Fenced/canceled/ambiguous work stays durable; never retry user code here.
          this.branches.markScriptUnknown(lease, error instanceof Error ? error.message : String(error));
        } finally {
          clearTimeout(timeout);
          // Failed close must retain its handle for shutdown/recovery retries.
          if (!ownedHandle.isAlive()) this.active.delete(lease.attemptId);
        }
      })();
      this.active.set(lease.attemptId, { handle: ownedHandle, done });
      control.end(lease.source);
      child.stdin!.end(lease.input);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch (cleanupError) {
          this.active.set(lease.attemptId, { handle, done: Promise.resolve() });
          this.branches.markScriptUnknown(lease, String(cleanupError)); return;
        }
      }
      this.branches.settleScript(lease, { failed: true, output: error instanceof Error ? error.message : String(error) });
    }
  }
  authorityStatus(): {
    authorities:number;pendingCleanupOperations:number;retainedTeardownFailures:number;
    blockers:ReadinessDto['deploymentDrain']['blockers'];
  } {
    const durable=this.store.sqlite.prepare(`SELECT COUNT(*) total,
      SUM(state='outcome_unknown') failed FROM branch_attempts
      WHERE state IN ('leased','running') OR (state='outcome_unknown' AND process_identity_json IS NOT NULL)`)
      .get() as {total:number;failed:number|null};
    const processes=Math.max(this.active.size,durable.total),operations=
      (this.options.installations?.activeOperationCount()??0)+(this.options.resources?.activeOperationCount()??0);
    const failed=Number(durable.failed??0),blockers:ReadinessDto['deploymentDrain']['blockers']=[];
    if(processes)blockers.push({kind:'workflow',reason:`${processes} supervised Branch process or retained process authority`,status:failed?'cleanup_failed':'active'});
    if(operations)blockers.push({kind:'workflow',reason:`${operations} Branch installation or resource operation still running`,status:'active'});
    return {authorities:processes+operations,pendingCleanupOperations:operations+failed,retainedTeardownFailures:failed,blockers};
  }
  requestStop(): void {
    this.stopped = true;
    this.options.installations?.requestStop();
    this.options.resources?.requestStop();
  }
  async stop(): Promise<void> {
    this.requestStop();
    await this.options.installations?.stop();
    await this.options.resources?.stop();
    const results = await Promise.allSettled([...this.active.values()].map(async operation => {
      await operation.handle.close(); await operation.done;
    }));
    const failures = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
    // Shutdown may precede the first tick; durable identities must also drain.
    failures.push(...await this.recoverScripts(true));
    if (failures.length) throw new AggregateError(failures, 'Branch Script cleanup remains pending');
    this.publishAudit();
  }
}
