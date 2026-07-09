// ThreadStore — the library that apps/server consumes. Ties together the on-disk
// event logs (source of truth), the SQLite projections, and the pure projectors.
// Exposes NO HTTP (SPEC §7). SQLite is never a source of truth: everything here is
// derivable from the logs + the *.json files, and `rebuildProjections()` proves it.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { asc, eq } from "drizzle-orm";
import type {
  ArtifactDto,
  ArtifactKind,
  CreateProjectRequest,
  CreateThreadRequest,
  MessageDto,
  ProjectDto,
  TaskDto,
  TaskStatus,
  ThreadDetailDto,
  ThreadDto,
  ThreadState,
  UpdateThreadRequest,
} from "@ponderosa/core";
import { openDb, type Db } from "./db.js";
import type Database from "better-sqlite3";
import { EventLog } from "./eventlog.js";
import type { LogEvent, StoredLogEvent } from "./log-event.js";
import {
  initProjectionState,
  projectAll,
  projectEvent,
  type ProjectionOp,
  type ProjectionState,
} from "./projectors.js";
import {
  artifacts,
  events,
  messages,
  projects,
  tasks,
  threads,
} from "./schema.js";
import {
  artifactsDir,
  attachmentsDir,
  dbPath,
  eventsPath,
  projectJsonPath,
  projectsDir,
  threadDir,
  threadJsonPath,
  threadsDir,
} from "./paths.js";

interface ProjectJson {
  id: string;
  label: string;
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface ThreadJson {
  id: string;
  projectId: string;
  title: string;
  activeEngine: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export class ThreadStore {
  private readonly db: Db;
  private readonly client: Database.Database;
  private readonly logs = new Map<string, EventLog>();
  private readonly states = new Map<string, ProjectionState>();

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(projectsDir(dataDir), { recursive: true });
    const opened = openDb(dbPath(dataDir));
    this.db = opened.db;
    this.client = opened.client;
  }

  /** Expose the drizzle db for advanced/read-only queries (e.g. the v2 search). */
  get database(): Db {
    return this.db;
  }

  /** The raw better-sqlite3 handle (read-only queries, PRAGMAs, tests). */
  get sqlite(): Database.Database {
    return this.client;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(input: CreateProjectRequest): ProjectDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ProjectJson = {
      id,
      label: input.label,
      hostPath: input.hostPath,
      createdAt: now,
    };
    writeJson(projectJsonPath(this.dataDir, id), record);
    mkdirSync(threadsDir(this.dataDir, id), { recursive: true });
    this.db
      .insert(projects)
      .values({ id, label: input.label, hostPath: input.hostPath, createdAt: now })
      .run();
    return { id, label: input.label, hostPath: input.hostPath, createdAt: now };
  }

  listProjects(): ProjectDto[] {
    return this.db
      .select()
      .from(projects)
      .all()
      .map((r) => ({
        id: r.id,
        label: r.label,
        hostPath: r.hostPath,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt ?? undefined,
      }));
  }

  getProject(id: string): ProjectDto | undefined {
    const r = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!r) return undefined;
    return {
      id: r.id,
      label: r.label,
      hostPath: r.hostPath,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? undefined,
    };
  }

  // ─── Threads ───────────────────────────────────────────────────────────────

  createThread(projectId: string, input: CreateThreadRequest): ThreadDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: ThreadJson = {
      id,
      projectId,
      title: input.title,
      activeEngine: input.engine,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    mkdirSync(threadDir(this.dataDir, projectId, id), { recursive: true });
    mkdirSync(artifactsDir(this.dataDir, projectId, id), { recursive: true });
    mkdirSync(attachmentsDir(this.dataDir, projectId, id), { recursive: true });
    writeJson(threadJsonPath(this.dataDir, projectId, id), record);
    this.db
      .insert(threads)
      .values({
        id,
        projectId,
        title: input.title,
        activeEngine: input.engine,
        createdAt: now,
        updatedAt: now,
        archived: 0,
      })
      .run();
    return this.rowToThreadDto(id)!;
  }

  listThreads(projectId: string): ThreadDto[] {
    return this.db
      .select()
      .from(threads)
      .where(eq(threads.projectId, projectId))
      .all()
      .map((r) => this.threadRowToDto(r));
  }

  getThread(id: string): ThreadDto | undefined {
    return this.rowToThreadDto(id);
  }

  updateThread(id: string, patch: UpdateThreadRequest): ThreadDto | undefined {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) return undefined;
    const now = new Date().toISOString();
    const title = patch.title ?? row.title;
    const archived = patch.archived ?? row.archived === 1;
    this.db
      .update(threads)
      .set({ title, archived: archived ? 1 : 0, updatedAt: now })
      .where(eq(threads.id, id))
      .run();
    // Keep the on-disk metadata (source of truth for these fields) in sync.
    const json = readJson<ThreadJson>(threadJsonPath(this.dataDir, row.projectId, id));
    writeJson(threadJsonPath(this.dataDir, row.projectId, id), {
      ...json,
      title,
      archived,
      updatedAt: now,
    });
    return this.rowToThreadDto(id);
  }

  /** Full four-pane hydration for GET /api/threads/:id (SPEC §8). */
  getThreadDetail(id: string): ThreadDetailDto | undefined {
    const thread = this.rowToThreadDto(id);
    if (!thread) return undefined;
    return {
      thread,
      messages: this.getMessages(id),
      tasks: this.getTasks(id),
      artifacts: this.getArtifacts(id),
      state: thread.state,
    };
  }

  getMessages(threadId: string): MessageDto[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.seq))
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        seq: r.seq,
        role: r.role === "user" ? "user" : "assistant",
        text: r.text,
        createdAt: r.createdAt,
      }));
  }

  getTasks(threadId: string): TaskDto[] {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.threadId, threadId))
      .orderBy(asc(tasks.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        title: r.title,
        status: r.status as TaskStatus,
        engine: r.engine,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  getArtifacts(threadId: string): ArtifactDto[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.threadId, threadId))
      .orderBy(asc(artifacts.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        taskId: r.taskId ?? undefined,
        kind: r.kind as ArtifactKind,
        path: r.path,
        summary: r.summary ?? undefined,
        createdAt: r.createdAt,
      }));
  }

  getArtifact(threadId: string, artifactId: string): ArtifactDto | undefined {
    const r = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .get();
    if (!r || r.threadId !== threadId) return undefined;
    return {
      id: r.id,
      threadId: r.threadId,
      taskId: r.taskId ?? undefined,
      kind: r.kind as ArtifactKind,
      path: r.path,
      summary: r.summary ?? undefined,
      createdAt: r.createdAt,
    };
  }

  // ─── Event log (append-only) + projection ──────────────────────────────────

  /**
   * Append one event to a thread's canonical log AND update its projections.
   * The log write happens (and fsyncs) BEFORE the projection, so the log is always
   * complete for replay (SPEC §8: log write before broadcast). Returns the stored
   * event (seq + ts) so the caller can broadcast it over SSE.
   */
  appendEvent(threadId: string, event: LogEvent): StoredLogEvent {
    const projectId = this.projectIdOf(threadId);
    const log = this.logFor(threadId, projectId);
    const stored = log.append(event);

    const state = this.stateFor(threadId, projectId);
    const { state: nextState, ops } = projectEvent(threadId, state, stored);
    this.states.set(threadId, nextState);
    this.applyOps(threadId, ops);
    return stored;
  }

  readEvents(threadId: string): StoredLogEvent[] {
    return this.logFor(threadId, this.projectIdOf(threadId)).readAll();
  }

  readEventsSince(threadId: string, sinceSeq: number): StoredLogEvent[] {
    return this.logFor(threadId, this.projectIdOf(threadId)).readSince(sinceSeq);
  }

  lastSeqOf(threadId: string): number {
    const evs = this.readEvents(threadId);
    return evs.length === 0 ? 0 : (evs[evs.length - 1]?.seq ?? 0);
  }

  // ─── Rebuild (SQLite is disposable; the log is truth) ──────────────────────

  /**
   * Wipe every projection table and replay from disk (the *.json files + each
   * `events.jsonl`). After this, projections are byte-identical to the incremental
   * result — the property the rebuild test asserts.
   */
  rebuildProjections(): void {
    this.db.delete(events).run();
    this.db.delete(artifacts).run();
    this.db.delete(tasks).run();
    this.db.delete(messages).run();
    this.db.delete(threads).run();
    this.db.delete(projects).run();
    this.logs.clear();
    this.states.clear();

    const root = projectsDir(this.dataDir);
    if (!existsSync(root)) return;

    for (const projectId of readdirSync(root)) {
      const pj = projectJsonPath(this.dataDir, projectId);
      if (!existsSync(pj)) continue;
      const p = readJson<ProjectJson>(pj);
      this.db
        .insert(projects)
        .values({
          id: p.id,
          label: p.label,
          hostPath: p.hostPath,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt ?? null,
        })
        .run();

      const tDir = threadsDir(this.dataDir, projectId);
      if (!existsSync(tDir)) continue;
      for (const threadId of readdirSync(tDir)) {
        const tj = threadJsonPath(this.dataDir, projectId, threadId);
        if (!existsSync(tj)) continue;
        const t = readJson<ThreadJson>(tj);
        this.db
          .insert(threads)
          .values({
            id: t.id,
            projectId: t.projectId,
            title: t.title,
            activeEngine: t.activeEngine,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            archived: t.archived ? 1 : 0,
          })
          .run();

        const logFile = eventsPath(this.dataDir, projectId, threadId);
        if (!existsSync(logFile)) continue;
        const stored = new EventLog(logFile).readAll();
        const ops = projectAll(threadId, stored, t.activeEngine);
        this.applyOps(threadId, ops);
      }
    }
  }

  close(): void {
    this.client.close();
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private applyOps(threadId: string, ops: ProjectionOp[]): void {
    // drizzle's transaction runs the callback immediately (all-or-nothing) and
    // provides a `tx` handle scoped to the transaction.
    this.db.transaction((tx) => {
      for (const op of ops) {
        switch (op.kind) {
          case "insert_message":
            tx.insert(messages).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_event":
            tx.insert(events).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_artifact":
            tx.insert(artifacts).values(op.row).onConflictDoNothing().run();
            break;
          case "insert_task":
            tx.insert(tasks)
              .values(op.row)
              .onConflictDoUpdate({
                target: tasks.id,
                set: {
                  title: op.row.title,
                  status: op.row.status,
                  engine: op.row.engine,
                  updatedAt: op.row.updatedAt,
                },
              })
              .run();
            break;
          case "update_task":
            tx.update(tasks)
              .set({ status: op.status, updatedAt: op.updatedAt })
              .where(eq(tasks.id, op.id))
              .run();
            break;
          case "set_session":
            tx.update(threads)
              .set(
                op.engine === "claude"
                  ? { claudeSessionId: op.sessionId }
                  : { codexSessionId: op.sessionId },
              )
              .where(eq(threads.id, threadId))
              .run();
            break;
          case "set_state":
            tx.update(threads)
              .set({ stateBranch: op.branch ?? null, stateCommit: op.commit ?? null })
              .where(eq(threads.id, threadId))
              .run();
            break;
          case "touch_thread":
            tx.update(threads)
              .set({ updatedAt: op.updatedAt })
              .where(eq(threads.id, threadId))
              .run();
            break;
        }
      }
    });
  }

  private projectIdOf(threadId: string): string {
    const row = this.db
      .select({ projectId: threads.projectId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (!row) throw new Error(`unknown thread: ${threadId}`);
    return row.projectId;
  }

  private logFor(threadId: string, projectId: string): EventLog {
    let log = this.logs.get(threadId);
    if (!log) {
      log = new EventLog(eventsPath(this.dataDir, projectId, threadId));
      this.logs.set(threadId, log);
    }
    return log;
  }

  private stateFor(threadId: string, projectId: string): ProjectionState {
    let state = this.states.get(threadId);
    if (!state) {
      // Rebuild the in-memory reducer state by folding the existing log.
      const engine = this.activeEngineOf(threadId);
      state = initProjectionState(engine);
      const existing = new EventLog(eventsPath(this.dataDir, projectId, threadId)).readAll();
      for (const stored of existing) {
        state = projectEvent(threadId, state, stored).state;
      }
      this.states.set(threadId, state);
    }
    return state;
  }

  private activeEngineOf(threadId: string): string {
    const row = this.db
      .select({ engine: threads.activeEngine })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    return row?.engine ?? "codex";
  }

  private rowToThreadDto(id: string): ThreadDto | undefined {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    return row ? this.threadRowToDto(row) : undefined;
  }

  private threadRowToDto(row: typeof threads.$inferSelect): ThreadDto {
    const state: ThreadState = {};
    if (row.stateBranch) state.branch = row.stateBranch;
    if (row.stateCommit) state.commit = row.stateCommit;
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      activeEngine: row.activeEngine,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archived: row.archived === 1,
    };
  }

  /** The engine session id to resume for a thread (undefined if none yet). */
  resumeSessionId(threadId: string): string | undefined {
    const row = this.db
      .select({
        engine: threads.activeEngine,
        codex: threads.codexSessionId,
        claude: threads.claudeSessionId,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    if (!row) return undefined;
    return (row.engine === "claude" ? row.claude : row.codex) ?? undefined;
  }
}
