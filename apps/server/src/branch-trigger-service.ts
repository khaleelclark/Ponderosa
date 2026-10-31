import path from "node:path";
import {realpathSync,statSync} from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { Cron } from "croner";
import picomatch from "picomatch";
import { interpolateBranchText, validateBranchConfiguration, type AgentStore, type BranchTriggerStore, type TriggerFilesystemBurst } from "@ponderosa/agents";
import type {
  TriggerDefinitionDto,
  TriggerFilesystemConfig,
  TriggerScheduleConfig,
  TriggerSourceConfig,
  TriggerSourceKind,
} from "@ponderosa/core";

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_SCHEDULE_OCCURRENCES_PER_POLL = 100;
const MAX_FILES_PER_OCCURRENCE = 500;
const MAX_FILESYSTEM_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_EXCLUDES = [".git/**", "node_modules/**", ".ponderosa/**"];

export function normalizeTriggerSourceConfig(
  sourceKind: TriggerSourceKind,
  config: TriggerSourceConfig,
  now = new Date(),
): { config: TriggerSourceConfig; nextFireAt?: string } {
  if (sourceKind === "schedule") {
    const schedule = config as TriggerScheduleConfig;
    if (schedule.scheduleKind === "once") {
      const at = new Date(schedule.at);
      if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) throw new Error("one-time schedule must be in the future");
      return { config: { scheduleKind: "once", at: at.toISOString() }, nextFireAt: at.toISOString() };
    }
    if (schedule.whenRunning !== undefined && !["update_current", "run_latest", "queue_all"].includes(schedule.whenRunning)) {
      throw new Error("whenRunning must be update_current, run_latest or queue_all");
    }
    // Absence preserves legacy queueing when an existing schedule is republished.
    const policy = schedule.whenRunning === undefined ? {} : { whenRunning: schedule.whenRunning };
    if (schedule.scheduleKind === "interval") {
      if (!Number.isInteger(schedule.everyMs) || schedule.everyMs < MIN_INTERVAL_MS || schedule.everyMs > MAX_INTERVAL_MS) {
        throw new Error("interval must be between 1 minute and 365 days");
      }
      const startsAt = new Date(schedule.startsAt);
      if (!Number.isFinite(startsAt.getTime())) throw new Error("interval startsAt must be an ISO timestamp");
      let next = startsAt.getTime();
      if (next <= now.getTime()) next += (Math.floor((now.getTime() - next) / schedule.everyMs) + 1) * schedule.everyMs;
      return {
        config: { scheduleKind: "interval", everyMs: schedule.everyMs, startsAt: startsAt.toISOString(), ...policy },
        nextFireAt: new Date(next).toISOString(),
      };
    }
    if (schedule.scheduleKind === "cron") {
      if (!schedule.expression?.trim() || !schedule.timezone?.trim()) throw new Error("cron expression and timezone are required");
      if (schedule.expression.trim().split(/\s+/).length !== 5) throw new Error("cron schedules must use five fields and cannot run more than once per minute");
      const cron = new Cron(schedule.expression.trim(), { timezone: schedule.timezone.trim(), paused: true });
      const next = cron.nextRun(now);
      if (!next) throw new Error("cron schedule has no future occurrence");
      return {
        config: { scheduleKind: "cron", expression: schedule.expression.trim(), timezone: schedule.timezone.trim(), ...policy },
        nextFireAt: next.toISOString(),
      };
    }
    throw new Error("invalid schedule configuration");
  }

  // Timestamp freshness was network admission, not a workflow condition.
  if (sourceKind === "webhook") return { config: {} };

  if(sourceKind!=='filesystem')throw new Error('Unknown Branch trigger source');
  const filesystem = config as TriggerFilesystemConfig;
  const include = Array.isArray(filesystem.include) && filesystem.include.length ? filesystem.include : ["**/*"];
  const exclude = [...new Set([...DEFAULT_EXCLUDES, ...(Array.isArray(filesystem.exclude) ? filesystem.exclude : [])])];
  const quietMs = filesystem.quietMs ?? 1_000;
  const maxWindowMs = filesystem.maxWindowMs ?? 10_000;
  if (!Number.isInteger(quietMs) || quietMs < 100 || quietMs > MAX_FILESYSTEM_WINDOW_MS) throw new Error("filesystem quiet window must be between 100 and 3600000 ms");
  if (!Number.isInteger(maxWindowMs) || maxWindowMs < quietMs || maxWindowMs > MAX_FILESYSTEM_WINDOW_MS) throw new Error("filesystem max window must be between quietMs and 3600000 ms");
  if (include.length > 100 || exclude.length > 100) throw new Error("filesystem sources support at most 100 include and 100 exclude patterns");
  for (const pattern of [...include, ...exclude]) {
    if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 500 || path.isAbsolute(pattern) || pattern.includes("..")) {
      throw new Error("filesystem patterns must be relative glob patterns without '..'");
    }
    picomatch(pattern);
  }
  return { config: { include, exclude, quietMs, maxWindowMs } };
}

interface FileBurst {
  startedAt: string;
  lastAt: string;
  quietTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
}

interface FilesystemRoute {
  trigger: TriggerDefinitionDto;
  configKey: string;
  include(path: string): boolean;
  exclude(path: string): boolean;
}

interface ProjectFilesystemWatcher {
  watcher: FSWatcher;
  projectPath: string;
  routes: Map<string, FilesystemRoute>;
  ready: Promise<void>;
  finishReady():void;
  observing: boolean;
}

export class BranchTriggerSourceService {
  private readonly watchers = new Map<string, ProjectFilesystemWatcher>();
  private readonly bursts = new Map<string, FileBurst>();
  private scheduleTimer?: NodeJS.Timeout;
  private scheduleCycleCutoff?: string;
  private lastDiagnosticFailureLoggedAt = 0;
  private scheduleCursor?: { nextFireAt: string; id: string };
  private refreshChain: Promise<void> = Promise.resolve();
  private started = false;
  private stopping = false;
  private stopFailure = false;

  constructor(private readonly options: {
    store: AgentStore;
    triggers: BranchTriggerStore;
    notify(triggerId?: string): void;
    onSourceFailure?(input: {
      trigger?: TriggerDefinitionDto;
      kind: "watcher" | "filesystem_persistence" | "schedule" | "schedule_polling";
      episode?: string;
      error: string;
    }): void;
    onSourceRecovered?(triggerId: string, kind: "watcher" | "filesystem_persistence" | "schedule" | "schedule_polling", episode?: string): void;
    logDiagnosticFailure?(): void;
    sourceAvailable?(): boolean;
  }) {
  }

  async start(): Promise<void> {
    if (this.stopping) return;
    this.started = true;
    await this.refresh();
  }

  requestStop():void {
    this.stopping = true;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
    for (const burst of this.bursts.values()) {
      clearTimeout(burst.quietTimer);
      clearTimeout(burst.maxTimer);
    }
    this.bursts.clear();
  }

  /** Watchers are active host authority only while a drain is closing them. */
  drainStatus():{authorities:number;retainedTeardownFailures:number} {
    return {authorities:this.watchers.size,retainedTeardownFailures:Number(this.stopFailure)};
  }

  async stop(): Promise<void> {
    this.requestStop();
    await this.refreshChain;
    const closed=await Promise.allSettled([...this.watchers.values()].map(async active=>{try{await active.watcher.close();}finally{active.finishReady();}}));
    const failures=closed.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    this.stopFailure=failures.length>0;
    if(failures.length)throw new AggregateError(failures,'Branch filesystem watchers remain active');
    this.watchers.clear();
  }

  /** Explicit definition changes can wait for the new watcher without delaying daemon startup. */
  async waitUntilReady(owner?:string):Promise<void>{await Promise.all([...this.watchers.entries()].filter(([id])=>!owner||id===owner).map(([,active])=>active.ready));}

  async refresh(): Promise<void> {
    if (this.stopping || !this.started) return;
    this.reportScheduleDiagnostic(() => this.options.onSourceRecovered?.("", "schedule"));
    const operation = this.refreshChain.then(() => this.refreshNow());
    this.refreshChain = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Apply one durable Trigger definition change without reconciling unrelated
   * sources. Webhooks are resolved from SQLite at intake and schedules are
   * discovered by the existing due-time query, so neither needs a registry
   * rebuild. Filesystem mutations use the serialized repair path.
   */
  async applyDefinitionChange(
    previous: TriggerDefinitionDto | undefined,
    next: TriggerDefinitionDto | undefined,
  ): Promise<void> {
    this.reportScheduleDiagnostic(() => this.options.onSourceRecovered?.("", "schedule"));
    const affectsFilesystem = [previous, next].some(
      (trigger) => trigger?.sourceKind === "filesystem" && trigger.enabled,
    );
    if (!affectsFilesystem || this.stopping || !this.started) return;
    const projectId = this.sourceOwner(next??previous!);
    const operation = this.refreshChain.then(() => this.refreshNow(projectId));
    this.refreshChain = operation.catch(() => undefined);
    await operation;
    await this.waitUntilReady(projectId);
  }

  /** Reconcile this Branch's durable filesystem source after an idempotent deploy replay. */
  async reconcileBranch(branchId:string):Promise<void> {
    if (this.stopping || !this.started) return;
    const operation=this.refreshChain.then(()=>this.refreshNow(`branch:${branchId}`));
    this.refreshChain=operation.catch(()=>undefined);
    await operation;
    await this.waitUntilReady(`branch:${branchId}`);
  }

  private destinationAvailable(trigger: TriggerDefinitionDto): boolean {
    return Boolean(this.options.store.sqlite.prepare("SELECT 1 FROM branches WHERE id=? AND trigger_id=? AND enabled=1 AND deleting=0").get(trigger.branchId,trigger.id));
  }
  private sourceRevision(trigger:TriggerDefinitionDto):string {
    const owner=this.options.store.sqlite.prepare('SELECT active_version_id,binding_revision_id,configuration_revision FROM branches WHERE id=? AND trigger_id=? AND deleting=0').get(trigger.branchId,trigger.id);
    return JSON.stringify({owner,config:trigger.sourceConfig});
  }
  private sourceOwner(trigger:TriggerDefinitionDto):string{return `branch:${trigger.branchId}`;}

  private sourceDirectory(owner:string):{hostPath:string}|undefined {
    const row=this.options.store.sqlite.prepare('SELECT b.bindings_json,v.definition_json,w.configuration_json FROM branches w JOIN branch_bindings b ON w.binding_revision_id=b.id JOIN branch_versions v ON w.active_version_id=v.id WHERE w.id=?').get(owner.slice(7)) as {bindings_json:string;definition_json:string;configuration_json:string}|undefined;
    if(!row)return undefined;
    try{
      const directory=JSON.parse(row.bindings_json).directories?.workspace;
      if(typeof directory!=='string'||!directory)return undefined;
      const definition=JSON.parse(row.definition_json),configuration=validateBranchConfiguration(JSON.parse(row.configuration_json),definition);
      const hostPath=realpathSync(interpolateBranchText(directory,definition,configuration));
      return statSync(hostPath).isDirectory()?{hostPath}:undefined;
    }catch{return undefined;}
  }

  private async refreshNow(onlyProjectId?: string): Promise<void> {
    if (this.stopping) return;
    if (!this.sourceAvailable()) {
      this.stopSchedulePolling();
      await this.deactivateFilesystemSources();
      return;
    }
    const desired:TriggerDefinitionDto[]=[];
    let cursor:string|undefined;
    for(;;){
      const page=this.options.triggers.listTriggerDefinitions(cursor,100,onlyProjectId?.slice(7));
      for(const trigger of page)if(trigger.enabled&&trigger.sourceKind==='filesystem'&&this.destinationAvailable(trigger))desired.push(trigger);
      if(page.length<100)break;cursor=page.at(-1)!.id;
    }
    const routesByProject = new Map<string, Map<string, FilesystemRoute>>();
    for (const trigger of desired) {
      const config = trigger.sourceConfig as TriggerFilesystemConfig;
      const routes = routesByProject.get(this.sourceOwner(trigger)) ?? new Map<string, FilesystemRoute>();
      routes.set(trigger.id, {
        trigger,
        configKey: this.sourceRevision(trigger),
        include: picomatch(config.include, { dot: true }),
        exclude: picomatch(config.exclude, { dot: true }),
      });
      routesByProject.set(this.sourceOwner(trigger), routes);
    }

    for (const [projectId, active] of this.watchers) {
      if (onlyProjectId && projectId !== onlyProjectId) continue;
      const project = this.sourceDirectory(projectId);
      const routes = routesByProject.get(projectId);
      if (!project || !routes || active.projectPath !== project.hostPath) {
        try{await active.watcher.close();}finally{active.finishReady();}
        this.watchers.delete(projectId);
        for (const triggerId of active.routes.keys()) this.clearBurst(triggerId);
        continue;
      }
      for (const [triggerId, previous] of active.routes) {
        const next = routes.get(triggerId);
        if (!next || next.configKey !== previous.configKey) this.clearBurst(triggerId);
      }
      active.routes = routes;
    }

    const ignoredByDefault = picomatch(DEFAULT_EXCLUDES, { dot: true });
    for (const [projectId, routes] of routesByProject) {
      if (!this.sourceAvailable()) {
        await this.deactivateFilesystemSources();
        return;
      }
      if (this.watchers.has(projectId)) continue;
      const project = this.sourceDirectory(projectId);
      if (!project) {
        for(const route of routes.values()){
          this.options.triggers.updateTriggerDefinition(route.trigger.id,{enabled:false});
          this.options.onSourceFailure?.({trigger:route.trigger,kind:'watcher',error:'The bound Branch workspace is unavailable or is not a directory'});
          this.options.notify(route.trigger.id);
        }
        continue;
      }
      const observationStartedAt=performance.timeOrigin+performance.now();
      const watcher = watch(project.hostPath, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        alwaysStat: true,
        ignored: (candidate) => {
          const relative = path.relative(project.hostPath, candidate).split(path.sep).join("/");
          return Boolean(relative && !relative.startsWith("../") && (ignoredByDefault(relative) || ignoredByDefault(`${relative}/`)));
        },
      });
      let finishReady!:()=>void;
      const ready=new Promise<void>(resolve=>{finishReady=resolve;watcher.once('ready',resolve);watcher.once('error',()=>resolve());});
      const active: ProjectFilesystemWatcher = { watcher, projectPath: project.hostPath, routes, ready,finishReady,observing:false };
      watcher.on("ready", () => {
        active.observing=true;
        for (const route of active.routes.values()) this.options.onSourceRecovered?.(route.trigger.id, "watcher");
      });
      watcher.on("error", (error) => {
        if (!this.sourceAvailable()) {
          void this.refresh().catch(() => undefined);
          return;
        }
        // Fail closed and make the inert source visible as disabled instead of
        // silently presenting an enabled automation that cannot observe files.
        for (const route of active.routes.values()) {
          this.options.triggers.updateTriggerDefinition(route.trigger.id, { enabled: false });
          this.options.onSourceFailure?.({
            trigger: route.trigger,
            kind: "watcher",
            error: error instanceof Error ? error.message : String(error),
          });
          this.options.notify(route.trigger.id);
        }
        void this.refresh().catch(() => undefined);
      });
      watcher.on("all", (event, changedPath, stats) => {
        // Some native backends emit scan-time changes despite ignoreInitial.
        // Admission begins only after the replacement inventory is complete.
        if(!active.observing)return;
        // fs.watch may deliver an old change after the new scan's ready event.
        // ctime also admits newly copied files that preserve an old mtime.
        if((event==='add'||event==='addDir'||event==='change')&&(!stats||Math.max(stats.mtimeMs,stats.ctimeMs,stats.birthtimeMs)<observationStartedAt))return;
        const relative = path.relative(project.hostPath, changedPath).split(path.sep).join("/");
        if (!relative || relative.startsWith("../")) return;
        for (const route of active.routes.values()) {
          if (route.include(relative) && !route.exclude(relative)) this.addFileEvent(route.trigger, relative, event,route.configKey);
        }
      });
      this.watchers.set(projectId, active);
    }
    if (!onlyProjectId) {
      this.restorePendingFileBursts();
      this.ensureSchedulePolling();
      await this.processDueSchedules();
    }
  }

  verifyAndRecordWebhook(input: {
    triggerId: string;
    eventId: string;
    payload: unknown;
    remoteAddress?: string;
  }): { occurrenceId: string; state: "pending" | "activated" | "cancelled" | "dead_lettered"; replayed: boolean } {
    if (!this.sourceAvailable()) throw new Error("Branch trigger sources are unavailable");
    const trigger = this.options.triggers.getTriggerDefinition(input.triggerId);
    if (!trigger || !trigger.enabled || trigger.sourceKind !== "webhook") throw new Error("webhook Branch trigger not found");
    if (!this.destinationAvailable(trigger)) throw new Error("Branch trigger destination is unavailable");
    if (!input.eventId.trim() || input.eventId.length > 200) throw new Error("X-Ponderosa-Event-Id is required");
    const result = this.options.triggers.recordTriggerOccurrence({
      triggerId: trigger.id,
      occurrenceKey: input.eventId,
      payload: input.payload,
      provenance: {
        source: "webhook",
        eventId: input.eventId,
        ...(input.remoteAddress ? { remoteAddress: input.remoteAddress } : {}),
      },
      now: new Date().toISOString(),
    });
    if (!result.replayed) this.options.notify(trigger.id);
    return { occurrenceId: result.occurrenceId, state: result.state, replayed: result.replayed };
  }

  private reportScheduleDiagnostic(report: () => void): void {
    try { report(); }
    catch {
      if (Date.now() - this.lastDiagnosticFailureLoggedAt >= 60_000) {
        this.lastDiagnosticFailureLoggedAt = Date.now();
        try { this.options.logDiagnosticFailure?.(); } catch { /* no recursive diagnostic failures */ }
      }
    }
  }

  async processDueSchedules(): Promise<void> {
    if (!this.sourceAvailable()) return;
    const now = new Date();
    this.scheduleCycleCutoff ??= now.toISOString();
    this.reportScheduleDiagnostic(() => this.options.onSourceRecovered?.("", "schedule"));
    let due: TriggerDefinitionDto[];
    try {
      due = this.options.triggers.listDueScheduleTriggers(this.scheduleCycleCutoff, 100, this.scheduleCursor);
      if (!due.length && this.scheduleCursor) {
        this.scheduleCursor = undefined;
        this.scheduleCycleCutoff = now.toISOString();
        due = this.options.triggers.listDueScheduleTriggers(now.toISOString());
      }
      if (!due.length) this.scheduleCycleCutoff = undefined;
      this.reportScheduleDiagnostic(() => this.options.onSourceRecovered?.("", "schedule_polling"));
    } catch {
      this.reportScheduleDiagnostic(() => this.options.onSourceFailure?.({ kind: "schedule_polling", error: "Schedule polling is temporarily unavailable (schedule_poll_failed). No scheduled work was accepted by this check; polling will retry." }));
      return;
    }
    for (const trigger of due) {
      const episode = trigger.nextFireAt;
      this.scheduleCursor = { nextFireAt: episode!, id: trigger.id };
      try {
        if (!this.destinationAvailable(trigger)) continue;
        this.fireSchedule(trigger, now);
      } catch {
        this.reportScheduleDiagnostic(() => this.options.onSourceFailure?.({ trigger, kind: "schedule", episode,
          error: "Scheduled check could not be accepted (schedule_accept_failed). Check current Trigger Events; unchanged due checks retry automatically." }));
        continue;
      }
      // Diagnostic persistence is not admission: a notification-write failure
      // after commit must never claim the accepted occurrence was rolled back.
      this.reportScheduleDiagnostic(() => this.options.onSourceRecovered?.(trigger.id, "schedule", episode));
    }
  }

  private fireSchedule(trigger: TriggerDefinitionDto, now: Date): void {
    const expected = trigger.nextFireAt;
    if (!expected) return;
    const config = trigger.sourceConfig as TriggerScheduleConfig;
    let cursor: Date | null = new Date(expected);
    const cron = config.scheduleKind === "cron"
      ? new Cron(config.expression, { timezone: config.timezone, paused: true }) : undefined;
    // Bound each poll without advancing past unaccepted due times.
    for (let count = 0; cursor && cursor.getTime() <= now.getTime() && count < MAX_SCHEDULE_OCCURRENCES_PER_POLL; count += 1) {
      const scheduledAt = cursor.toISOString();
      const next: Date | null = config.scheduleKind === "once" ? null
        : config.scheduleKind === "interval" ? new Date(cursor.getTime() + config.everyMs)
        : cron!.nextRun(cursor);
      this.options.triggers.recordScheduledTriggerOccurrence({
        triggerId: trigger.id,
        occurrenceKey: `schedule:${scheduledAt}:${scheduledAt}`,
        expectedNextFireAt: scheduledAt,
        ...(next ? { nextFireAt: next.toISOString() } : {}),
        lastFiredAt: scheduledAt,
        payload: { scheduledTimes: [scheduledAt], missedCount: 1, collapsedRecovery: false },
        provenance: { source: "schedule", evaluatedAt: now.toISOString() },
        now: now.toISOString(),
      });
      this.options.notify(trigger.id);
      cursor = next;
    }
  }

  private addFileEvent(trigger: TriggerDefinitionDto, changedPath: string, type: string,revision:string): void {
    if (!this.sourceAvailable()) return;
    const current=this.options.triggers.getTriggerDefinition(trigger.id);
    if(!current?.enabled||current.sourceKind!=='filesystem'||!this.destinationAvailable(current)||this.sourceRevision(current)!==revision)return;
    trigger=current;
    const now = new Date().toISOString();
    try {
      const burst = this.options.triggers.recordFilesystemTriggerEvent({
        triggerId: trigger.id,
        path: changedPath,
        eventType: type,
        maxCapturedPaths: MAX_FILES_PER_OCCURRENCE,
        now,
      });
      this.scheduleFileBurst(trigger, burst);
      this.options.onSourceRecovered?.(trigger.id, "filesystem_persistence");
    } catch (error) {
      this.options.onSourceFailure?.({
        trigger,
        kind: "filesystem_persistence",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private flushFileBurst(triggerId: string): void {
    this.clearBurst(triggerId);
    if (!this.sourceAvailable()) return;
    const owner = this.options.triggers.getTriggerDefinition(triggerId);
    if (!owner || !owner.enabled || !this.destinationAvailable(owner)) return;
    try {
      const result = this.options.triggers.flushFilesystemTriggerBurst(triggerId);
      if (result) this.options.notify(triggerId);
      this.options.onSourceRecovered?.(triggerId, "filesystem_persistence");
    } catch (error) {
      const trigger = this.options.triggers.getTriggerDefinition(triggerId);
      if (!trigger || !trigger.enabled) return;
      this.options.onSourceFailure?.({
        trigger,
        kind: "filesystem_persistence",
        error: error instanceof Error ? error.message : String(error),
      });
      const pending=this.options.triggers.getFilesystemTriggerBurst(triggerId);
      if (pending) this.scheduleFileBurst(trigger, pending);
    }
  }

  private restorePendingFileBursts(): void {
    if (!this.sourceAvailable()) return;
    let cursor:string|undefined;
    for(;;){const page=this.options.triggers.listPendingFilesystemTriggerBursts(cursor,100);
      for(const burst of page){const trigger=this.options.triggers.getTriggerDefinition(burst.triggerId);if(trigger?.enabled&&trigger.sourceKind==='filesystem'&&this.destinationAvailable(trigger))this.scheduleFileBurst(trigger,burst);}
      if(page.length<100)break;cursor=page.at(-1)!.triggerId;
    }
  }

  private scheduleFileBurst(trigger: TriggerDefinitionDto, burst: TriggerFilesystemBurst): void {
    this.clearBurst(trigger.id);
    const config = trigger.sourceConfig as TriggerFilesystemConfig;
    const now = Date.now();
    const quietDelay = Math.max(0, Date.parse(burst.lastAt) + config.quietMs - now);
    const maxDelay = Math.max(0, Date.parse(burst.startedAt) + config.maxWindowMs - now);
    this.bursts.set(trigger.id, {
      startedAt: burst.startedAt,
      lastAt: burst.lastAt,
      quietTimer: setTimeout(() => this.flushFileBurst(trigger.id), quietDelay),
      maxTimer: setTimeout(() => this.flushFileBurst(trigger.id), maxDelay),
    });
  }

  private clearBurst(id: string): void {
    const burst = this.bursts.get(id);
    if (!burst) return;
    clearTimeout(burst.quietTimer);
    clearTimeout(burst.maxTimer);
    this.bursts.delete(id);
  }

  private ensureSchedulePolling(): void {
    if (this.scheduleTimer||!this.sourceAvailable()) return;
    this.scheduleTimer = setInterval(() => { void this.processDueSchedules().catch(() => {
      this.reportScheduleDiagnostic(() => this.options.onSourceFailure?.({ kind: "schedule_polling", error: "Schedule polling is temporarily unavailable (schedule_poll_failed). Polling will retry." }));
    }); }, 1_000);
    this.scheduleTimer.unref();
  }

  private stopSchedulePolling(): void {
    if (!this.scheduleTimer) return;
    clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
  }

  private async deactivateFilesystemSources(): Promise<void> {
    for (const id of [...this.bursts.keys()]) this.clearBurst(id);
    const closed=await Promise.allSettled([...this.watchers.values()].map(async active=>{try{await active.watcher.close();}finally{active.finishReady();}}));
    const failures=closed.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(failures.length)throw new AggregateError(failures,'Branch filesystem watchers remain active');
    this.watchers.clear();
  }

  private sourceAvailable(): boolean {
    return !this.stopping&&(this.options.sourceAvailable?.()??true);
  }

}
