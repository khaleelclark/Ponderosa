import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { Cron } from "croner";
import picomatch from "picomatch";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
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
  if (!Number.isInteger(quietMs) || quietMs < 100 || quietMs > 10_000) throw new Error("filesystem quiet window must be between 100 and 10000 ms");
  if (!Number.isInteger(maxWindowMs) || maxWindowMs < quietMs || maxWindowMs > 10_000) throw new Error("filesystem max window must be between quietMs and 10000 ms");
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
  eventCount: number;
  changes: Map<string, Set<string>>;
  droppedPathEventCount: number;
  quietTimer: NodeJS.Timeout;
  maxTimer: NodeJS.Timeout;
}

export class TriggerSourceService {
  readonly secrets: TriggerSecretStore;
  private readonly watchers = new Map<string, { watcher: FSWatcher; configKey: string; ready: Promise<void> }>();
  private readonly bursts = new Map<string, FileBurst>();
  private scheduleTimer?: NodeJS.Timeout;
  private refreshChain: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(private readonly options: {
    store: AgentStore;
    coordination: CoordinationV3Store;
    dataDir: string;
    notify(triggerId?: string): void;
    now?: () => Date;
  }) {
    this.secrets = new TriggerSecretStore(options.dataDir);
  }

  async start(): Promise<void> {
    await this.refresh();
    this.scheduleTimer = setInterval(() => { void this.processDueSchedules().catch(() => undefined); }, 1_000);
    this.scheduleTimer.unref();
    await this.processDueSchedules();
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
    if (this.stopping) return;
    const operation = this.refreshChain.then(() => this.refreshNow());
    this.refreshChain = operation.catch(() => undefined);
    return operation;
  }

  private async refreshNow(): Promise<void> {
    if (this.stopping) return;
    const desired = new Map(this.options.coordination.listTriggerDefinitions()
      .filter((trigger) => {
        const agent = this.options.store.getAgent(trigger.agentId);
        const conversation = this.options.store.getConversation(trigger.conversationId);
        return trigger.enabled && trigger.sourceKind === "filesystem" && Boolean(
          agent && !agent.archived && conversation && !conversation.archived && agent.conversationIds.includes(conversation.id),
        );
      })
      .map((trigger) => [trigger.id, trigger]));
    for (const [id, active] of this.watchers) {
      const trigger = desired.get(id);
      const configKey = trigger ? JSON.stringify(trigger.sourceConfig) : undefined;
      if (trigger && active.configKey === configKey) continue;
      await active.watcher.close();
      this.watchers.delete(id);
      this.clearBurst(id);
    }
    for (const trigger of desired.values()) {
      if (this.watchers.has(trigger.id)) continue;
      const project = this.options.store.getProject(trigger.projectId);
      if (!project) continue;
      const config = trigger.sourceConfig as TriggerFilesystemConfig;
      const include = picomatch(config.include, { dot: true });
      const exclude = picomatch(config.exclude, { dot: true });
      const watcher = watch(project.hostPath, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignored: (candidate) => {
          const relative = path.relative(project.hostPath, candidate).split(path.sep).join("/");
          return Boolean(relative && !relative.startsWith("../") && (exclude(relative) || exclude(`${relative}/`)));
        },
      });
      const ready = new Promise<void>((resolve) => watcher.once("ready", resolve));
      watcher.on("error", () => {
        // Fail closed and make the inert source visible as disabled instead of
        // silently presenting an enabled automation that cannot observe files.
        this.options.coordination.updateTriggerDefinition(trigger.id, { enabled: false });
        this.options.notify(trigger.id);
        void this.refresh().catch(() => undefined);
      });
      watcher.on("all", (event, changedPath) => {
        const relative = path.relative(project.hostPath, changedPath).split(path.sep).join("/");
        if (!relative || relative.startsWith("../") || !include(relative) || exclude(relative)) return;
        this.addFileEvent(trigger, relative, event);
      });
      this.watchers.set(trigger.id, { watcher, configKey: JSON.stringify(trigger.sourceConfig), ready });
    }
  }

  /** Deterministic qualification seam; production CRUD does not wait for a
   * potentially large Project tree to finish its initial watcher scan. */
  async waitForFilesystemWatchers(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((active) => active.ready));
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
  }): { occurrenceId: string; replayed: boolean } {
    const trigger = this.options.coordination.getTriggerDefinition(input.triggerId);
    if (!trigger || !trigger.enabled || trigger.sourceKind !== "webhook") throw new Error("webhook Trigger not found");
    const agent = this.options.store.getAgent(trigger.agentId);
    const conversation = this.options.store.getConversation(trigger.conversationId);
    if (!agent || agent.archived || !conversation || conversation.archived || !agent.conversationIds.includes(conversation.id)) {
      throw new Error("webhook Trigger owner is unavailable");
    }
    if (!input.eventId.trim() || input.eventId.length > 200) throw new Error("X-Ponderosa-Event-Id is required");
    const timestampSeconds = Number(input.timestamp);
    const config = trigger.sourceConfig as TriggerWebhookConfig;
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > config.replayWindowSeconds) {
      throw new Error("webhook timestamp is outside the replay window");
    }
    const ciphertext = this.options.coordination.getTriggerSecretCiphertext(trigger.id);
    if (!ciphertext) throw new Error("webhook Trigger has no signing secret");
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
      now: this.now().toISOString(),
    });
    if (!result.replayed) this.options.notify(trigger.id);
    return { occurrenceId: result.occurrenceId, replayed: result.replayed };
  }

  async processDueSchedules(): Promise<void> {
    const now = this.now();
    for (const trigger of this.options.coordination.listDueScheduleTriggers(now.toISOString())) {
      try {
        const agent = this.options.store.getAgent(trigger.agentId);
        const conversation = this.options.store.getConversation(trigger.conversationId);
        if (!agent || agent.archived || !conversation || conversation.archived || !agent.conversationIds.includes(conversation.id)) continue;
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
    const now = this.now().toISOString();
    const config = trigger.sourceConfig as TriggerFilesystemConfig;
    const current = this.bursts.get(trigger.id);
    if (current) {
      current.lastAt = now;
      current.eventCount += 1;
      const kinds = current.changes.get(changedPath);
      if (kinds) kinds.add(type);
      else if (current.changes.size < MAX_FILES_PER_OCCURRENCE) current.changes.set(changedPath, new Set([type]));
      else current.droppedPathEventCount += 1;
      clearTimeout(current.quietTimer);
      current.quietTimer = setTimeout(() => this.flushFileBurst(trigger), config.quietMs);
      return;
    }
    const burst: FileBurst = {
      startedAt: now,
      lastAt: now,
      eventCount: 1,
      changes: new Map([[changedPath, new Set([type])]]),
      droppedPathEventCount: 0,
      quietTimer: setTimeout(() => this.flushFileBurst(trigger), config.quietMs),
      maxTimer: setTimeout(() => this.flushFileBurst(trigger), config.maxWindowMs),
    };
    this.bursts.set(trigger.id, burst);
  }

  private flushFileBurst(trigger: TriggerDefinitionDto): void {
    const burst = this.bursts.get(trigger.id);
    if (!burst) return;
    this.clearBurst(trigger.id);
    const changed = [...burst.changes].map(([filePath, types]) => ({ path: filePath, types: [...types] }));
    try {
      this.options.coordination.recordTriggerOccurrence({
        triggerId: trigger.id,
        occurrenceKey: `filesystem:${randomUUID()}`,
        payload: {
          changes: changed,
          lowLevelEventCount: burst.eventCount,
          capturedPathCount: burst.changes.size,
          startedAt: burst.startedAt,
          endedAt: burst.lastAt,
          ...(burst.droppedPathEventCount ? {
            pathLimitReached: true,
            droppedPathEventCount: burst.droppedPathEventCount,
          } : {}),
        },
        provenance: { source: "project_filesystem", watcher: "project_root", contentInjected: false },
        now: burst.lastAt,
      });
      this.options.notify(trigger.id);
    } catch {
      // The Trigger may have been disabled or deleted while its quiet-window
      // timer was pending. Its buffered event must not escape that lifecycle.
    }
  }

  private clearBurst(id: string): void {
    const burst = this.bursts.get(id);
    if (!burst) return;
    clearTimeout(burst.quietTimer);
    clearTimeout(burst.maxTimer);
    this.bursts.delete(id);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
