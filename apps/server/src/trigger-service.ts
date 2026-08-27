import { createHmac } from "node:crypto";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { Cron } from "croner";
import picomatch from "picomatch";
import type { AgentStore, CoordinationV3Store, TriggerFilesystemBurst } from "@ponderosa/agents";
import type {
  TriggerDefinitionDto,
  TriggerFilesystemConfig,
  TriggerScheduleConfig,
  TriggerSourceConfig,
  TriggerSourceKind,
  TriggerWebhookConfig,
} from "@ponderosa/core";
import { TriggerSecretStore } from "./trigger-secrets.js";

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_MISSED_TIMES = 10_000;
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
    if (schedule.scheduleKind === "interval") {
      if (!Number.isInteger(schedule.everyMs) || schedule.everyMs < MIN_INTERVAL_MS || schedule.everyMs > MAX_INTERVAL_MS) {
        throw new Error("interval must be between 1 minute and 365 days");
      }
      const startsAt = new Date(schedule.startsAt);
      if (!Number.isFinite(startsAt.getTime())) throw new Error("interval startsAt must be an ISO timestamp");
      let next = startsAt.getTime();
      if (next <= now.getTime()) next += (Math.floor((now.getTime() - next) / schedule.everyMs) + 1) * schedule.everyMs;
      return {
        config: { scheduleKind: "interval", everyMs: schedule.everyMs, startsAt: startsAt.toISOString() },
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
        config: { scheduleKind: "cron", expression: schedule.expression.trim(), timezone: schedule.timezone.trim() },
        nextFireAt: next.toISOString(),
      };
    }
    throw new Error("invalid schedule configuration");
  }

  if (sourceKind === "webhook") {
    const webhook = config as TriggerWebhookConfig;
    const replayWindowSeconds = webhook.replayWindowSeconds ?? 300;
    if (!Number.isInteger(replayWindowSeconds) || replayWindowSeconds < 30 || replayWindowSeconds > 3_600) {
      throw new Error("webhook replay window must be between 30 and 3600 seconds");
    }
    return { config: { replayWindowSeconds } };
  }

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
}

export class TriggerSourceService {
  readonly secrets: TriggerSecretStore;
  private readonly watchers = new Map<string, ProjectFilesystemWatcher>();
  private readonly bursts = new Map<string, FileBurst>();
  private scheduleTimer?: NodeJS.Timeout;
  private refreshChain: Promise<void> = Promise.resolve();
  private started = false;
  private stopping = false;

  constructor(private readonly options: {
    store: AgentStore;
    coordination: CoordinationV3Store;
    dataDir: string;
    notify(triggerId?: string): void;
    onSourceFailure?(input: {
      trigger: TriggerDefinitionDto;
      kind: "watcher" | "filesystem_persistence";
      error: string;
    }): void;
    onSourceRecovered?(triggerId: string, kind: "watcher" | "filesystem_persistence"): void;
    onBudgetReset?(): void;
    projectAvailable?(projectId: string): boolean;
    sourceAvailable?(): boolean;
  }) {
    this.secrets = new TriggerSecretStore(options.dataDir);
  }

  async start(): Promise<void> {
    if (this.stopping) return;
    this.started = true;
    await this.refresh();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.refreshChain;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
    for (const burst of this.bursts.values()) {
      clearTimeout(burst.quietTimer);
      clearTimeout(burst.maxTimer);
    }
    this.bursts.clear();
    await Promise.all([...this.watchers.values()].map(({ watcher }) => watcher.close()));
    this.watchers.clear();
  }

  async refresh(): Promise<void> {
    if (this.stopping || !this.started) return;
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
    const affectsFilesystem = [previous, next].some(
      (trigger) => trigger?.sourceKind === "filesystem" && trigger.enabled,
    );
    if (!affectsFilesystem || this.stopping || !this.started) return;
    const projectId = next?.projectId ?? previous!.projectId;
    const operation = this.refreshChain.then(() => this.refreshNow(projectId));
    this.refreshChain = operation.catch(() => undefined);
    await operation;
  }

  private async refreshNow(onlyProjectId?: string): Promise<void> {
    if (this.stopping) return;
    if (!this.sourceAvailable()) {
      this.stopSchedulePolling();
      await this.deactivateFilesystemSources();
      return;
    }
    const desired = this.options.coordination.listTriggerDefinitions()
      .filter((trigger) => !onlyProjectId || trigger.projectId === onlyProjectId)
      .filter((trigger) => {
        const agent = this.options.store.getAgent(trigger.targetAgentId);
        const conversation = this.options.store.getConversation(trigger.conversationId);
        return trigger.enabled && trigger.sourceKind === "filesystem" &&
          (this.options.projectAvailable?.(trigger.projectId) ?? true) && Boolean(
          agent && !agent.archived && conversation && !conversation.deletedAt && !conversation.archived && agent.conversationId === conversation.id,
        );
      });
    const routesByProject = new Map<string, Map<string, FilesystemRoute>>();
    for (const trigger of desired) {
      const config = trigger.sourceConfig as TriggerFilesystemConfig;
      const routes = routesByProject.get(trigger.projectId) ?? new Map<string, FilesystemRoute>();
      routes.set(trigger.id, {
        trigger,
        configKey: JSON.stringify(trigger.sourceConfig),
        include: picomatch(config.include, { dot: true }),
        exclude: picomatch(config.exclude, { dot: true }),
      });
      routesByProject.set(trigger.projectId, routes);
    }

    for (const [projectId, active] of this.watchers) {
      if (onlyProjectId && projectId !== onlyProjectId) continue;
      const project = this.options.store.getProject(projectId);
      const routes = routesByProject.get(projectId);
      if (!project || !routes || active.projectPath !== project.hostPath) {
        await active.watcher.close();
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
      const project = this.options.store.getProject(projectId);
      if (!project) continue;
      const watcher = watch(project.hostPath, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignored: (candidate) => {
          const relative = path.relative(project.hostPath, candidate).split(path.sep).join("/");
          return Boolean(relative && !relative.startsWith("../") && (ignoredByDefault(relative) || ignoredByDefault(`${relative}/`)));
        },
      });
      const ready = new Promise<void>((resolve) => watcher.once("ready", resolve));
      const active: ProjectFilesystemWatcher = { watcher, projectPath: project.hostPath, routes, ready };
      watcher.on("ready", () => {
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
          this.options.coordination.updateTriggerDefinition(route.trigger.id, { enabled: false });
          this.options.onSourceFailure?.({
            trigger: route.trigger,
            kind: "watcher",
            error: error instanceof Error ? error.message : String(error),
          });
          this.options.notify(route.trigger.id);
        }
        void this.refresh().catch(() => undefined);
      });
      watcher.on("all", (event, changedPath) => {
        const relative = path.relative(project.hostPath, changedPath).split(path.sep).join("/");
        if (!relative || relative.startsWith("../")) return;
        for (const route of active.routes.values()) {
          if (route.include(relative) && !route.exclude(relative)) this.addFileEvent(route.trigger, relative, event);
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

  createWebhookSecret(): { secret: string; ciphertext: string; fingerprint: string } {
    return this.secrets.create();
  }

  verifyAndRecordWebhook(input: {
    triggerId: string;
    eventId: string;
    timestamp: string;
    signature: string;
    rawBody: Buffer;
    payload: unknown;
    remoteAddress?: string;
  }): { occurrenceId: string; state: "pending" | "activated" | "cancelled" | "dead_lettered"; replayed: boolean } {
    if (!this.sourceAvailable()) throw new Error("Automation sources are unavailable");
    const trigger = this.options.coordination.getTriggerDefinition(input.triggerId);
    if (!trigger || !trigger.enabled || trigger.sourceKind !== "webhook") throw new Error("webhook Automation not found");
    if (!(this.options.projectAvailable?.(trigger.projectId) ?? true)) throw new Error("Automation Project is unavailable");
    const agent = this.options.store.getAgent(trigger.targetAgentId);
    const conversation = this.options.store.getConversation(trigger.conversationId);
    if (!agent || agent.archived || !conversation || conversation.deletedAt || conversation.archived || agent.conversationId !== conversation.id) {
      throw new Error("Automation destination or execution Agent is unavailable");
    }
    if (!input.eventId.trim() || input.eventId.length > 200) throw new Error("X-Ponderosa-Event-Id is required");
    const timestampSeconds = Number(input.timestamp);
    const config = trigger.sourceConfig as TriggerWebhookConfig;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > config.replayWindowSeconds) {
      throw new Error("webhook timestamp is outside the replay window");
    }
    const ciphertext = this.options.coordination.getTriggerSecretCiphertext(trigger.id);
    if (!ciphertext) throw new Error("webhook Automation has no signing secret");
    const secret = this.secrets.decrypt(ciphertext);
    const expected = `v1=${createHmac("sha256", secret).update(`${input.timestamp}.${input.eventId}.`).update(input.rawBody).digest("hex")}`;
    if (!this.secrets.equal(expected, input.signature)) throw new Error("invalid webhook signature");
    const result = this.options.coordination.recordTriggerOccurrence({
      triggerId: trigger.id,
      occurrenceKey: input.eventId,
      payload: input.payload,
      provenance: {
        source: "signed_webhook",
        eventId: input.eventId,
        timestamp: new Date(timestampSeconds * 1_000).toISOString(),
        signatureVersion: "v1",
        ...(input.remoteAddress ? { remoteAddress: input.remoteAddress } : {}),
      },
      now: new Date().toISOString(),
    });
    if (!result.replayed) this.options.notify(trigger.id);
    return { occurrenceId: result.occurrenceId, state: result.state, replayed: result.replayed };
  }

  async processDueSchedules(): Promise<void> {
    if (!this.sourceAvailable()) return;
    const now = new Date();
    if (this.options.coordination.resetExpiredTriggerBudgets(now.toISOString()) > 0) {
      this.options.onBudgetReset?.();
    }
    for (const trigger of this.options.coordination.listDueScheduleTriggers(now.toISOString())) {
      try {
        if (!(this.options.projectAvailable?.(trigger.projectId) ?? true)) continue;
        const agent = this.options.store.getAgent(trigger.targetAgentId);
        const conversation = this.options.store.getConversation(trigger.conversationId);
        if (!agent || agent.archived || !conversation || conversation.deletedAt || conversation.archived || agent.conversationId !== conversation.id) continue;
        this.fireSchedule(trigger, now);
      } catch {
        // A concurrent edit or one malformed historical definition must not
        // prevent other due Triggers from advancing. It remains visible as due.
      }
    }
  }

  private fireSchedule(trigger: TriggerDefinitionDto, now: Date): void {
    const expected = trigger.nextFireAt;
    if (!expected) return;
    const config = trigger.sourceConfig as TriggerScheduleConfig;
    const missed: string[] = [];
    let cursor = new Date(expected);
    let next: Date | null = null;
    let missedCount = 0;
    let exactIntervalRange: { first: string; last: string; everyMs: number; count: number } | undefined;
    let truncatedCron = false;
    if (config.scheduleKind === "once") {
      missed.push(cursor.toISOString());
    } else if (config.scheduleKind === "interval") {
      missedCount = Math.floor((now.getTime() - cursor.getTime()) / config.everyMs) + 1;
      if (missedCount <= MAX_MISSED_TIMES) {
        for (let index = 0; index < missedCount; index += 1) {
          missed.push(new Date(cursor.getTime() + index * config.everyMs).toISOString());
        }
      } else {
        exactIntervalRange = {
          first: cursor.toISOString(),
          last: new Date(cursor.getTime() + (missedCount - 1) * config.everyMs).toISOString(),
          everyMs: config.everyMs,
          count: missedCount,
        };
        missed.push(exactIntervalRange.first, exactIntervalRange.last);
      }
      next = new Date(cursor.getTime() + missedCount * config.everyMs);
    } else {
      const cron = new Cron(config.expression, { timezone: config.timezone, paused: true });
      while (cursor.getTime() <= now.getTime() && missed.length < MAX_MISSED_TIMES) {
        missed.push(cursor.toISOString());
        const candidate = cron.nextRun(cursor);
        if (!candidate) break;
        cursor = candidate;
      }
      truncatedCron = cursor.getTime() <= now.getTime();
      if (truncatedCron) {
        const latest = cron.previousRuns(1, now)[0];
        if (latest && missed.at(-1) !== latest.toISOString()) missed.push(latest.toISOString());
      }
      next = cursor.getTime() > now.getTime() ? cursor : cron.nextRun(now);
    }
    if (!missed.length) return;
    const last = missed.at(-1)!;
    this.options.coordination.recordScheduledTriggerOccurrence({
      triggerId: trigger.id,
      occurrenceKey: `schedule:${missed[0]}:${last}`,
      expectedNextFireAt: expected,
      ...(next ? { nextFireAt: next.toISOString() } : {}),
      lastFiredAt: last,
      payload: {
        ...(exactIntervalRange ? { exactIntervalRange } : { scheduledTimes: missed }),
        ...(truncatedCron ? { enumeratedCount: missed.length } : { missedCount: missedCount || missed.length }),
        collapsedRecovery: (missedCount || missed.length) > 1,
        ...(truncatedCron ? { truncatedCronHistory: true, enumeratedLimit: MAX_MISSED_TIMES } : {}),
      },
      provenance: { source: "schedule", evaluatedAt: now.toISOString() },
      now: now.toISOString(),
    });
    this.options.notify(trigger.id);
  }

  private addFileEvent(trigger: TriggerDefinitionDto, changedPath: string, type: string): void {
    if (!this.sourceAvailable()) return;
    if (!(this.options.projectAvailable?.(trigger.projectId) ?? true)) return;
    const now = new Date().toISOString();
    try {
      const burst = this.options.coordination.recordFilesystemTriggerEvent({
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
    const owner = this.options.coordination.getTriggerDefinition(triggerId);
    if (!owner || !owner.enabled || !(this.options.projectAvailable?.(owner.projectId) ?? true)) return;
    try {
      const result = this.options.coordination.flushFilesystemTriggerBurst(triggerId);
      if (result) this.options.notify(triggerId);
      this.options.onSourceRecovered?.(triggerId, "filesystem_persistence");
    } catch (error) {
      const trigger = this.options.coordination.getTriggerDefinition(triggerId);
      if (!trigger || !trigger.enabled) return;
      this.options.onSourceFailure?.({
        trigger,
        kind: "filesystem_persistence",
        error: error instanceof Error ? error.message : String(error),
      });
      const pending = this.options.coordination.listPendingFilesystemTriggerBursts()
        .find((burst) => burst.triggerId === triggerId);
      if (pending) this.scheduleFileBurst(trigger, pending);
    }
  }

  private restorePendingFileBursts(): void {
    if (!this.sourceAvailable()) return;
    for (const burst of this.options.coordination.listPendingFilesystemTriggerBursts()) {
      const trigger = this.options.coordination.getTriggerDefinition(burst.triggerId);
      if (trigger?.enabled && trigger.sourceKind === "filesystem") this.scheduleFileBurst(trigger, burst);
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
    if (this.scheduleTimer) return;
    this.scheduleTimer = setInterval(() => { void this.processDueSchedules().catch(() => undefined); }, 1_000);
    this.scheduleTimer.unref();
  }

  private stopSchedulePolling(): void {
    if (!this.scheduleTimer) return;
    clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
  }

  private async deactivateFilesystemSources(): Promise<void> {
    for (const id of [...this.bursts.keys()]) this.clearBurst(id);
    await Promise.all([...this.watchers.values()].map(({ watcher }) => watcher.close()));
    this.watchers.clear();
  }

  private sourceAvailable(): boolean {
    return this.options.sourceAvailable?.() ?? true;
  }

}
