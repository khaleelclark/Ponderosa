import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import type { ActiveRun } from "./app-contracts.js";
import type { createOperationalNotifications } from "./operational-notifications.js";

// A conservative observation, not a provider timeout or a claim of failure.
// Check twice a minute and warn after fifteen minutes without a provider event.
export const RUN_INACTIVITY_WARNING_MS = 15 * 60_000;
export const RUN_INACTIVITY_SCAN_MS = 30_000;
const PREFIX = "provider-inactivity:";
const terminal = new Set(["completed", "failed", "cancelled", "outcome_unknown"]);

type Operational = ReturnType<typeof createOperationalNotifications>;
interface Context {
  activeRuns: Map<string, ActiveRun>;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  workspace: WorkspaceStore;
  ownsRun(agentId: string, run: ActiveRun): boolean;
  createOperationalNotification: Operational["createOperationalNotification"];
  resolveOperationalNotification: Operational["resolveOperationalNotification"];
  logWarn(meta: Record<string, unknown>, message: string): void;
}

export function createRunInactivityMonitor(context: Context) {
  // A known wait resets the quiet observation window. Do not warn immediately
  // when a user answers a Decision or resumes a paused Run.
  const eligibleSince = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  const check = (now = Date.now()): void => {
    const quiet = new Set<string>();
    const observed = new Set<string>();
    const decisions = context.workspace.listDecisions({ status: "pending" });
    for (const [agentId, run] of context.activeRuns) {
      const id = run.v3SchedulerRunId;
      if (!id) continue;
      const key = PREFIX + id;
      observed.add(key);
      if (!context.ownsRun(agentId, run)) { quiet.add(key); continue; }
      if (run.ownershipState !== "running" || run.controller.signal.aborted) {
        quiet.add(key); continue;
      }
      const knownWait = !!context.coordinationV3.runPause(id) || decisions.some(decision =>
        decision.blocking && decision.agentId === agentId &&
        (decision.coordinationRunId === id || decision.runId === run.runId));
      if (knownWait) { eligibleSince.set(key, now); continue; }
      const started = Date.parse(run.startedAt);
      const last = run.lastEventReceivedAt ? Date.parse(run.lastEventReceivedAt) : started;
      if (!Number.isFinite(started) || !Number.isFinite(last)) { quiet.add(key); continue; }
      const since = Math.max(started, last, eligibleSince.get(key) ?? started);
      if (now - since < RUN_INACTIVITY_WARNING_MS) continue;
      const agent = context.store.getAgent(agentId);
      if (!agent) { quiet.add(key); continue; }
      quiet.add(key);
      context.createOperationalNotification({
        dedupeKey: key, category: "provider", severity: "attention", push: false,
        renewAfterRecovery: true,
        title: `${agent.title} has no recent provider activity`,
        body: "Ponderosa has received no provider events for at least 15 minutes. The Run may still be working or waiting on a tool. Review its work before deciding whether to stop it.",
        projectId: agent.projectId, ...(agent.conversationId ? { conversationId: agent.conversationId } : {}),
        agentId, action: { kind: "open_agent", targetId: agentId },
      });
    }
    const open: string[] = [];
    context.workspace.forEachOpenOperationalNotification(PREFIX, item => { if (item.dedupeKey) open.push(item.dedupeKey); });
    for (const key of open) {
      if (quiet.has(key)) continue;
      if (observed.has(key)) { context.resolveOperationalNotification(key); continue; }
      // An absent in-memory Run may be recovering after a restart. Only clear
      // its warning after durable termination, not simply because it vanished.
      const row = context.store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id=?").get(key.slice(PREFIX.length)) as { status: string } | undefined;
      if (row && terminal.has(row.status)) context.resolveOperationalNotification(key);
    }
    for (const key of eligibleSince.keys()) if (!observed.has(key)) eligibleSince.delete(key);
  };
  const start = (): void => {
    if (timer) return;
    const scan = () => { try { check(); } catch (error) { context.logWarn({ error }, "provider inactivity check failed"); } };
    scan();
    timer = setInterval(scan, RUN_INACTIVITY_SCAN_MS);
    timer.unref();
  };
  const stop = (): void => { if (timer) clearInterval(timer); timer = undefined; };
  return { check, start, stop };
}
